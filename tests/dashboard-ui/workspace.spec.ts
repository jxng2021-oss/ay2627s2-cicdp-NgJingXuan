import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { email, expectNothingStored, openSection, signUp } from "./helpers";

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://127.0.0.1:8080";

test.describe.configure({ mode: "serial" });

let workspace: string;
let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await (
    await browser.newContext({
      permissions: ["clipboard-read", "clipboard-write"],
    })
  ).newPage();
  page.on("dialog", (dialog) => {
    throw new Error(`unexpected dialog: ${dialog.message()}`);
  });
  workspace = await signUp(page, email("owner"), "Owner Workspace");
});
test.afterAll(async () => page.context().close());

test("create an API key: shown once with a warning and a copy button, then revoke it", async () => {
  await openSection(page, "API keys");
  await expect(page.getByText("No API keys yet.")).toBeVisible();

  await page.getByRole("button", { name: "Create API key" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Create API key" });
  await dialog.getByRole("button", { name: "Create API key" }).click();
  await expect(dialog.getByText("Name the key, like ci-deploy.")).toBeVisible();
  await dialog.getByLabel("Name").fill("ci-deploy");
  await dialog.getByRole("button", { name: "Create API key" }).click();

  await expect(page.getByText("Copy your new API key now")).toBeVisible();
  const key =
    (await page.getByLabel("New API key", { exact: true }).textContent()) ?? "";
  expect(key).toMatch(/^sk_local_/);
  await page.getByRole("button", { name: "Copy API key" }).click();
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(key);
  expect(page.url()).not.toContain(key);
  await expectNothingStored(page);

  await page.getByRole("button", { name: "Hide API key" }).click();
  await expect(page.getByText(key)).toHaveCount(0);
  const row = page.getByRole("row", { name: /ci-deploy/ });
  await expect(row.getByText("Active")).toBeVisible();

  await row.getByRole("button", { name: "Revoke key" }).click();
  const confirm = page.getByRole("dialog", { name: "Revoke API key" });
  await expect(confirm).toContainText("This can't be undone.");
  await confirm.getByRole("button", { name: "Revoke key" }).click();
  await expect(row.getByText("Revoked")).toBeVisible();
  await expect(row.getByRole("button", { name: "Revoke key" })).toHaveCount(0);

  await row.getByRole("button", { name: "Remove" }).click();
  const remove = page.getByRole("dialog", { name: "Remove revoked API key" });
  await expect(remove).toContainText("The audit log keeps its history.");
  await remove.getByRole("button", { name: "Keep it" }).click();
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Remove" }).click();
  await remove.getByRole("button", { name: "Remove key" }).click();
  await expect(page.getByText("API key ci-deploy removed")).toBeVisible();
  await expect(page.getByRole("row", { name: /ci-deploy/ })).toHaveCount(0);
  await expect(page.getByText("No API keys yet.")).toBeVisible();
});

test("the sidebar groups third-party services, and every link has an icon", async () => {
  const nav = page.getByRole("navigation", { name: "Workspace" });
  for (const [menu, links] of [
    ["Third-party services", ["Connections", "Webhooks"]],
    ["User management", ["User pools", "User activity"]],
  ] as const) {
    const toggle = nav.getByRole("button", { name: menu });
    if ((await toggle.getAttribute("aria-expanded")) !== "true")
      await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    for (const label of links) {
      const link = nav.getByRole("link", { name: label, exact: true });
      await expect(link).toBeVisible();
      await expect(link.locator(".nav-icon svg")).toHaveCount(1);
    }
  }
  await expect(
    nav.getByRole("link", { name: "Connections", exact: true }),
  ).toHaveAttribute("href", `/workspaces/${workspace}/connections`);
  await nav.getByRole("button", { name: "Third-party services" }).click();
  await expect(
    nav.getByRole("link", { name: "Webhooks", exact: true }),
  ).toBeHidden();
});

test("secrets: create, never readable back, view versions, rotate and delete", async () => {
  await openSection(page, "Secrets");
  await page.getByRole("button", { name: "Create secret" }).click();
  const form = page.getByRole("dialog", { name: "Create secret" });
  await form.getByLabel("Name").fill("bad name!");
  await form.getByLabel("Value").fill("x");
  await form.getByRole("button", { name: "Save secret" }).click();
  await expect(form.getByText(/Use 1 to 128 letters/)).toBeVisible();
  await form.getByLabel("Name").fill("db-password");
  await form.getByLabel("Value").fill("ui-first-value-123");
  await form.getByRole("button", { name: "Save secret" }).click();

  const row = page.getByRole("row", { name: /db-password/ });
  await expect(row).toContainText("v1");
  await expect(page.getByText("ui-first-value-123")).toHaveCount(0);

  await expect(row.getByRole("button", { name: /Reveal/ })).toHaveCount(0);
  await expect(page.getByText("ui-first-value-123")).toHaveCount(0);
  expect(page.url()).not.toContain("ui-first-value");
  await expectNothingStored(page);

  await row.getByRole("link", { name: "Details of db-password" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "db-password" }),
  ).toBeVisible();
  await page.getByLabel("New value").fill("ui-second-value-456");
  await page.getByRole("button", { name: "Rotate secret" }).click();
  await expect(page.getByText("Secret db-password rotated")).toBeVisible();
  const versions = page.getByRole("region", { name: "Versions" });
  await expect(versions).toContainText("v2 (current)");
  await expect(versions).toContainText("v1");
  await expect(page.getByText("ui-second-value-456")).toHaveCount(0);

  await page.getByRole("button", { name: "Delete secret" }).click();
  await page
    .getByRole("dialog", { name: "Delete secret" })
    .getByRole("button", { name: "Delete secret" })
    .click();
  await expect(page.getByText("No secrets yet.")).toBeVisible();
});

test("files: upload with progress, a script-like name shown as text, download, delete", async () => {
  await openSection(page, "Files");
  const name = "<img src=x onerror=alert(1)> <script>alert(2).txt";
  const contents = "Uploaded from the dashboard test.\n";

  await page.locator("#file-upload").setInputFiles({
    name,
    mimeType: "text/plain",
    buffer: Buffer.from(contents),
  });

  const row = page.getByRole("row", { name: /onerror/ });
  await expect(row).toBeVisible();
  await expect(row.getByRole("cell").first()).toHaveText(name);
  expect(await page.locator("table img, table script").count()).toBe(0);
  await expect(
    page.getByText(/of 30 MB used|of [0-9.]+ [KMG]B used/),
  ).toBeVisible();

  await row.getByRole("link", { name: /^Details of / }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
  await expect(page.getByRole("region", { name: "Details" })).toContainText(
    "text/plain",
  );
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download file" }).click();
  const file = await download;
  expect(readFileSync(await file.path(), "utf8")).toBe(contents);

  await page.getByRole("button", { name: "Delete file" }).click();
  await page
    .getByRole("dialog", { name: "Delete file" })
    .getByRole("button", { name: "Delete file" })
    .click();
  await expect(page.getByText("No files yet.")).toBeVisible();
});

test("connections: create and remove (confirmed)", async () => {
  await openSection(page, "Connections");
  await page.getByRole("link", { name: "Create connection" }).click();
  await page.waitForURL("**/connections/new");
  await page.getByLabel("Name", { exact: true }).fill("mock");
  await page.getByLabel("Base URL").fill("http://mock-upstream:4000/api");
  await page.getByLabel("Secret name").fill("mock-key");
  await page.getByRole("button", { name: "Create connection" }).click();

  await page.waitForURL("**/connections/mock");
  await expect(
    page.getByRole("heading", { level: 1, name: "mock" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "All connections" }).click();
  const row = page.getByRole("row", { name: /mock-upstream/ });
  await expect(row).toBeVisible();
  await row.getByRole("link", { name: "Details of mock" }).click();
  await page.getByRole("button", { name: "Remove connection" }).click();
  await page
    .getByRole("dialog", { name: "Remove connection" })
    .getByRole("button", { name: "Remove connection" })
    .click();
  await expect(page.getByText("No connections yet.")).toBeVisible();
});

test("webhooks: create an endpoint with a Stripe secret, copy its address, delete it (confirmed)", async () => {
  await openSection(page, "Secrets");
  await page.getByRole("button", { name: "Create secret" }).click();
  const secretForm = page.getByRole("dialog", { name: "Create secret" });
  await secretForm.getByLabel("Name").fill("stripe-webhook-secret");
  await secretForm.getByLabel("Value").fill("whsec_uitest0123456789abcdef");
  await secretForm.getByRole("button", { name: "Save secret" }).click();
  await expect(
    page.getByRole("row", { name: /stripe-webhook-secret/ }),
  ).toBeVisible();

  await openSection(page, "Webhooks");
  await expect(page.getByText("No webhook endpoints yet.")).toBeVisible();
  await page.getByRole("button", { name: "Create endpoint" }).click();
  const form = page.getByRole("dialog", { name: "Create a webhook endpoint" });
  await form.getByRole("button", { name: "Create endpoint" }).click();
  await expect(form.getByText("Choose one of your secrets.")).toBeVisible();
  await form
    .getByLabel("Stripe signing secret")
    .selectOption("stripe-webhook-secret");
  await form.getByRole("button", { name: "Create endpoint" }).click();

  const endpoint = page.getByRole("region", { name: "stripe" });
  await expect(
    endpoint.getByText("Your dev app pulls", { exact: true }),
  ).toBeVisible();
  await expect(
    endpoint.getByText(/\/v1\/webhooks\/[0-9a-f-]{36}/),
  ).toBeVisible();
  await expect(endpoint.getByText("No events yet.")).toBeVisible();
  await expect(page.getByText("whsec_uitest")).toHaveCount(0);

  const stripeUrl =
    (await endpoint
      .locator("code", { hasText: "/v1/webhooks/" })
      .textContent()) ?? "";
  const event = JSON.stringify({
    id: "evt_ui_pull",
    type: "checkout.session.completed",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: "cs_test_ui",
        payment_status: "paid",
        amount_total: 1800,
        currency: "sgd",
        payment_intent: "pi_ui",
        metadata: { order_id: "order-ui" },
      },
    },
  });
  const signedAt = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", "whsec_uitest0123456789abcdef")
    .update(`${signedAt}.${event}`)
    .digest("hex");
  const delivered = await page.request.post(
    `${GATEWAY_URL}/v1/webhooks/${stripeUrl.split("/v1/webhooks/")[1]}`,
    {
      headers: {
        "content-type": "application/json",
        "stripe-signature": `t=${signedAt},v1=${signature}`,
      },
      data: event,
    },
  );
  expect(delivered.status()).toBe(200);
  await page.reload();
  const eventRow = endpoint.getByRole("row", { name: /Payment succeeded/ });
  await expect(eventRow).toContainText("order-ui");
  await expect(eventRow).toContainText("18.00 SGD");
  await expect(eventRow.getByText("Pull mode")).toBeVisible();
  await expect(page.getByText("Waiting for pull")).toHaveCount(0);
  await endpoint.getByRole("button", { name: "Copy Stripe address" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
    /\/v1\/webhooks\/[0-9a-f-]{36}$/,
  );

  await endpoint.getByRole("button", { name: "Delete endpoint" }).click();
  await page
    .getByRole("dialog", { name: "Delete the stripe endpoint?" })
    .getByRole("button", { name: "Delete endpoint" })
    .click();
  await expect(page.getByText("No webhook endpoints yet.")).toBeVisible();
});

test("the audit log shows the matching events, with request IDs, and filters", async () => {
  await openSection(page, "Audit log");
  await expect(page.getByRole("cell").first()).toBeVisible();
  const recorded = [
    "user.signed_up",
    "api_key.created",
    "api_key.revoked",
    "api_key.deleted",
    "secret.created",
    "secret.rotated",
    "secret.deleted",
    "file.uploaded",
    "file.deleted",
    "webhook_endpoint.created",
    "webhook_endpoint.deleted",
  ];
  await page.getByRole("button", { name: "Action Any" }).click();
  const actions = page.getByRole("group", { name: "Action" });
  for (const action of recorded) await actions.getByLabel(action).check();
  await page.keyboard.press("Escape");
  await expect(actions).toBeHidden();
  await expect(
    page.getByRole("button", { name: `Action ${recorded.length} chosen` }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Apply filters" }).click();
  for (const action of recorded) {
    await expect(
      page.getByRole("cell", { name: action, exact: true }).first(),
    ).toBeVisible();
  }
  await expect(
    page.getByRole("cell", { name: "secret.read", exact: true }),
  ).toHaveCount(0);

  await page
    .getByRole("row", { name: /secret.rotated/ })
    .getByRole("button", { name: "Details of secret.rotated" })
    .click();
  const details = page.locator(".event-details").first();
  await expect(details).toContainText("Source IP");
  const requestId = await details.locator("code[title]").getAttribute("title");
  expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);

  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByRole("button", { name: "Action Any" })).toBeVisible();
  await page.getByRole("button", { name: "Action Any" }).click();
  await actions.getByLabel("secret.rotated").check();
  await actions.getByLabel("file.deleted").check();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Action 2 chosen" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(
    page.getByRole("cell", { name: "secret.rotated", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("cell", { name: "file.deleted", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("cell", { name: "file.uploaded", exact: true }),
  ).toHaveCount(0);
  expect(page.url()).toContain(`/workspaces/${workspace}/audit`);
});

test("the overview's activity counts what happened, for the chosen range", async () => {
  await openSection(page, "Overview");
  await page.waitForURL(`**/workspaces/${workspace}`);
  const tile = (label: string) =>
    page
      .getByRole("region", { name: label })
      .locator(".stat-value [aria-hidden]");
  await expect(async () => {
    await page.reload();
    await expect(tile("Files moved")).not.toHaveText("0", { timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  await expect(tile("Changes")).not.toHaveText("0");
  await expect(tile("Calls through connections")).toHaveText("0");
  await expect(
    page.getByRole("list", { name: "Events by type" }),
  ).toContainText("Files uploaded");

  const thirty = page.getByRole("button", { name: "30 days" });
  await thirty.click();
  await expect(thirty).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByText(/from the previous 30 days/).first(),
  ).toBeVisible();

  const chart = page.getByRole("group", { name: /Calls per day/ });
  await chart.focus();
  await expect(chart.locator(".chart-tooltip")).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(chart.locator(".chart-tooltip")).toContainText("Succeeded");
});

test("user pools: create one, see how to connect, and delete it (confirmed)", async () => {
  await openSection(page, "User pools");
  await expect(page.getByText("No user pools yet.")).toBeVisible();

  await page.getByRole("button", { name: "Create user pool" }).click();
  const dialog = page.getByRole("dialog", { name: "Create user pool" });
  await dialog.getByLabel("Name").fill("<b>bad</b>");
  await dialog.getByRole("button", { name: "Create user pool" }).click();
  await expect(dialog.getByText(/1 to 64 letters, digits/)).toBeVisible();
  await dialog.getByLabel("Name").fill("Shop customers");
  await dialog.getByLabel("Access token lifetime (minutes)").fill("10");
  await dialog.getByRole("button", { name: "Create user pool" }).click();

  await page.getByRole("link", { name: "Shop customers", exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Shop customers" }),
  ).toBeVisible();
  await expect(page.getByText(/Access tokens last 10 minutes/)).toBeVisible();
  const jwks = page.locator("code[title$='/jwks.json']");
  await expect(jwks).toHaveAttribute(
    "title",
    /\/v1\/user-pools\/[0-9a-f-]{36}\/jwks\.json$/,
  );
  await expect(jwks).toContainText("…");
  await expect(
    page.getByRole("button", { name: "Copy public keys URL" }),
  ).toBeVisible();
  await expect(page.getByText(/No users yet/)).toBeVisible();

  const roles = page.getByRole("region", { name: "Roles" });
  await expect(roles.getByText("No roles yet.")).toBeVisible();
  await roles.getByRole("button", { name: "Create role" }).click();
  const roleForm = page.getByRole("dialog", { name: "Create role" });
  await roleForm.getByLabel("Name").fill("Support");
  await roleForm
    .getByLabel("Permissions")
    .fill(["orders:read", "orders:refund"].join("\n"));
  await roleForm.getByRole("button", { name: "Create role" }).click();
  await expect(roleForm.getByText(/lowercase letters/)).toBeVisible();
  await roleForm.getByLabel("Name").fill("support");
  await roleForm
    .getByLabel("Permissions")
    .fill(["orders:read", "drop table"].join("\n"));
  await roleForm.getByRole("button", { name: "Create role" }).click();
  await expect(
    roleForm.getByText(/"drop table" isn't a permission/),
  ).toBeVisible();
  await roleForm
    .getByLabel("Permissions")
    .fill(["orders:read", "orders:refund"].join("\n"));
  await roleForm.getByRole("button", { name: "Create role" }).click();
  await expect(page.getByText("Role support created")).toBeVisible();
  const row = roles.getByRole("row", { name: /support/ });
  await expect(row).toContainText("orders:refund");

  await row.getByRole("button", { name: "Edit role support" }).click();
  const edit = page.getByRole("dialog", { name: "Edit role support" });
  await edit.getByLabel("Permissions").fill("orders:*");
  await edit.getByRole("button", { name: "Save role" }).click();
  await expect(row).toContainText("orders:*");

  await row.getByRole("button", { name: "Delete role support" }).click();
  await page
    .getByRole("dialog", { name: "Delete role" })
    .getByRole("button", { name: "Delete role" })
    .click();
  await expect(roles.getByText("No roles yet.")).toBeVisible();
  const poolUrl = page.url();

  await openSection(page, "User activity");
  await page
    .getByLabel("User pool", { exact: true })
    .selectOption({ label: "Shop customers" });
  for (const action of [
    "pool_role.created",
    "pool_role.updated",
    "pool_role.deleted",
  ]) {
    await expect(
      page.getByRole("cell", { name: action, exact: true }),
    ).toHaveCount(1);
  }
  await page.getByRole("button", { name: "Action Any" }).click();
  const actions = page.getByRole("group", { name: "Action" });
  await actions.getByLabel("pool_role.created").check();
  await actions.getByLabel("pool_role.deleted").check();
  await page.getByRole("button", { name: "Outcome Any" }).click();
  await expect(actions).toBeHidden();
  await page
    .getByRole("group", { name: "Outcome" })
    .getByLabel("success")
    .check();
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(
    page.getByRole("cell", { name: "pool_role.created", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("cell", { name: "pool_role.deleted", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("cell", { name: "pool_role.updated", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByRole("button", { name: "Action Any" })).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "pool_role.updated", exact: true }),
  ).toHaveCount(1);
  await page.goto(poolUrl);

  await page.getByRole("button", { name: "Delete user pool" }).click();
  const confirm = page.getByRole("dialog", { name: "Delete user pool" });
  await expect(confirm).toContainText("This can't be undone.");
  await confirm.getByRole("button", { name: "Delete user pool" }).click();
  await page.waitForURL(`**/workspaces/${workspace}/user-pools`);
  await expect(page.getByText("No user pools yet.")).toBeVisible();
});

test("feature flags: create one, choose who sees it in production, and check a user", async () => {
  await openSection(page, "Feature flags");
  await expect(page.getByText("No flags yet.")).toBeVisible();
  await page.getByRole("button", { name: "Create flag" }).click();
  const dialog = page.getByRole("dialog", { name: "Create flag" });
  const name = dialog.getByRole("textbox", { name: "Name" });
  await name.fill("Sale Banner");
  await dialog.getByRole("button", { name: "Create flag" }).click();
  await expect(dialog.getByText(/lowercase letters/)).toBeVisible();
  await name.fill("sale-banner");
  await dialog.getByRole("button", { name: "Create flag" }).click();

  await expect(
    page.getByRole("heading", { level: 1, name: "sale-banner" }),
  ).toBeVisible();
  await expect(page.getByText(/Off: every user can't see it/)).toBeVisible();

  await page.getByRole("button", { name: "Add users by email" }).click();
  const picker = page.getByRole("dialog", { name: "Add users by email" });
  await expect(
    picker.getByText(/no user pools in this workspace/),
  ).toBeVisible();
  await picker.getByRole("button", { name: "Close" }).click();

  await page.getByRole("switch", { name: /Turn on in production/ }).check();
  await page.getByLabel("Everyone else", { exact: true }).selectOption("true");
  await expect(page.getByText("Every user can see it.")).toBeVisible();
  await page.getByRole("button", { name: "Save production" }).click();
  await expect(page.getByText("sale-banner saved in production")).toBeVisible();

  await page.getByLabel("User ID").fill("user-7");
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Result" }),
  ).toContainText("Can see it, because they aren't a chosen user");

  await page.getByRole("link", { name: "All flags" }).click();
  await expect(page.getByText("On for everyone")).toBeVisible();
});

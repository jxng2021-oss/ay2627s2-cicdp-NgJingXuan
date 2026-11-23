import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { email, expectNothingStored, openSection, signUp } from "./helpers";

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

test("the audit log shows the matching events, with request IDs, and filters", async () => {
  await openSection(page, "Audit log");
  for (const action of [
    "user.signed_up",
    "api_key.created",
    "api_key.revoked",
    "secret.created",
    "secret.rotated",
    "secret.deleted",
    "file.uploaded",
    "file.deleted",
  ]) {
    await expect(
      page.getByRole("cell", { name: action, exact: true }).first(),
    ).toBeVisible();
  }
  await page
    .getByRole("row", { name: /secret.rotated/ })
    .getByRole("button", { name: "Details of secret.rotated" })
    .click();
  const details = page.locator(".event-details").first();
  await expect(details).toContainText("Source IP");
  const requestId = await details.locator("code[title]").getAttribute("title");
  expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);

  await page.getByLabel("Action").selectOption("secret.rotated");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(
    page.getByRole("cell", { name: "secret.rotated", exact: true }),
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

  await page.getByRole("button", { name: "Delete user pool" }).click();
  const confirm = page.getByRole("dialog", { name: "Delete user pool" });
  await expect(confirm).toContainText("This can't be undone.");
  await confirm.getByRole("button", { name: "Delete user pool" }).click();
  await page.waitForURL(`**/workspaces/${workspace}/user-pools`);
  await expect(page.getByText("No user pools yet.")).toBeVisible();
});

test("feature flags: create one, target it in production, and test a user", async () => {
  await openSection(page, "Feature flags");
  await expect(page.getByText("No flags yet.")).toBeVisible();
  await page.getByRole("button", { name: "Create flag" }).click();
  const dialog = page.getByRole("dialog", { name: "Create flag" });
  await dialog.getByLabel("Key").fill("Sale Banner");
  await dialog.getByRole("button", { name: "Create flag" }).click();
  await expect(dialog.getByText(/lowercase letters/)).toBeVisible();
  await dialog.getByLabel("Key").fill("sale-banner");
  await dialog.getByRole("button", { name: "Create flag" }).click();

  await page.getByRole("link", { name: "Details of sale-banner" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "sale-banner" }),
  ).toBeVisible();
  await page.getByLabel("Flag is on in production").check();
  await page.getByRole("button", { name: "Add rule" }).click();
  await page.getByLabel("Attribute", { exact: true }).fill("country");
  await page.getByLabel("Values", { exact: true }).fill("SG");
  await page.getByRole("button", { name: "Save production" }).click();
  await expect(page.getByText("sale-banner saved in production")).toBeVisible();

  await page.getByLabel("Attributes").fill("country=SG");
  await page.getByRole("button", { name: "Test", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Serves" }),
  ).toContainText("Serves true: rule 1 matched");
  await page.getByLabel("Attributes").fill("country=MY");
  await page.getByRole("button", { name: "Test", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Serves" }),
  ).toContainText("Serves false");
});

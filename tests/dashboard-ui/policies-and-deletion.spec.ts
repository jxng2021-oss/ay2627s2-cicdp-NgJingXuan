import { expect, test } from "@playwright/test";
import { email, errorBanner, openSection, signUp } from "./helpers";

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://127.0.0.1:8080";

test("an owner sets a policy, a refused call shows in the audit log, and the policy can be edited", async ({
  page,
  request,
}) => {
  await signUp(page, email("policy"), "Policy Workspace");

  await openSection(page, "API keys");
  await page.getByRole("button", { name: "Create API key" }).first().click();
  const keyDialog = page.getByRole("dialog", { name: "Create API key" });
  await keyDialog.getByLabel("Name").fill("shop-server");
  await keyDialog.getByRole("button", { name: "Create API key" }).click();
  const apiKey =
    (await page.getByLabel("New API key", { exact: true }).textContent()) ?? "";
  await page.getByRole("button", { name: "Hide API key" }).click();

  await openSection(page, "Connections");
  await page.getByRole("link", { name: "Create connection" }).click();
  await page.waitForURL("**/connections/new");
  const form = page.getByRole("main");
  await form.getByLabel("Name", { exact: true }).fill("payments");
  await form
    .getByLabel("Base URL")
    .fill("http://mock-upstream:4000/api/payments");
  await form.getByLabel("Secret name").fill("payment-key");
  await form.getByLabel("Allowed routes").fill("POST /charges\nfly /away");
  await form.getByLabel("Max per call").fill("500");
  await form.getByLabel("Max per day").fill("400");
  await form.getByRole("button", { name: "Create connection" }).click();
  await expect(form.getByText(/Check: fly \/away/)).toBeVisible();
  await expect(
    form.getByText("The daily limit can't be less than the limit per call."),
  ).toBeVisible();
  await form.getByLabel("Allowed routes").fill("POST /charges");
  await form.getByLabel("Max per day").fill("800");
  await form.getByRole("button", { name: "Create connection" }).click();

  await page.waitForURL("**/connections/payments");
  const details = page.getByRole("region", { name: "Details" });
  await expect(details).toContainText("Only POST /charges");
  await expect(details).toContainText("amount ≤ 500 per call, 800 per day");
  const connectionUrl = page.url();

  const refused = await request.post(
    `${GATEWAY_URL}/v1/proxy/payments/charges`,
    {
      headers: { authorization: `Bearer ${apiKey}` },
      data: { amount: 900 },
    },
  );
  expect(refused.status()).toBe(403);
  const { error } = (await refused.json()) as {
    error: { code: string; requestId: string };
  };
  expect(error.code).toBe("PROXY_POLICY_DENIED");

  await openSection(page, "Audit log");
  await page.waitForURL("**/audit");
  const denied = page.getByRole("row", { name: /proxy_connection\.denied/ });
  await expect(async () => {
    await page.reload();
    await expect(denied.first()).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  await denied
    .first()
    .getByRole("button", { name: "Details of proxy_connection.denied" })
    .click();
  await expect(
    page.locator(".event-details code[title]").first(),
  ).toHaveAttribute("title", error.requestId);

  await page.goto(connectionUrl);
  const usage = page.getByRole("region", { name: "Usage" });
  await expect(usage).toContainText("0 of 800 amount");
  await expect(
    usage.getByRole("meter", { name: "Amount today" }),
  ).toBeVisible();

  const edit = page.getByRole("region", { name: "Edit policy" });
  await expect(edit.getByLabel("Max per call")).toHaveValue("500");
  await edit.getByLabel("Max per call").fill("1000");
  await edit.getByLabel("Max per day").fill("5000");
  await edit.getByRole("button", { name: "Save policy" }).click();
  await expect(details).toContainText("amount ≤ 1,000 per call, 5,000 per day");
});

test("an owner deletes a workspace after typing its name; it is gone for good", async ({
  page,
}) => {
  const workspace = await signUp(page, email("shred"), "Shred Workspace");
  await openSection(page, "Settings");
  await expect(
    page.getByRole("heading", { name: "Delete workspace" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Delete workspace" }).click();

  const dialog = page.getByRole("dialog", { name: "Delete workspace" });
  await dialog.getByLabel("Workspace name").fill("shred workspace");
  await dialog.getByRole("button", { name: "Delete workspace" }).click();
  await expect(
    dialog.getByText("Type the workspace's name exactly as shown."),
  ).toBeVisible();

  await dialog.getByLabel("Workspace name").fill("Shred Workspace");
  await dialog.getByRole("button", { name: "Delete workspace" }).click();
  await page.waitForURL("**/workspaces");
  await expect(
    page.getByRole("heading", { name: "No workspaces" }),
  ).toBeVisible();

  await page.goto(`/workspaces/${workspace}`);
  await expect(
    page.getByRole("heading", { name: "Page not found" }),
  ).toBeVisible();
  await expect(errorBanner(page)).toHaveCount(0);
});

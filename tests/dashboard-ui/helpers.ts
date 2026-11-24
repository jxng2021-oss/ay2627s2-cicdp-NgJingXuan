import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export const PASSWORD = `ui-test-${randomBytes(9).toString("base64url")}`;

export function email(name: string): string {
  return `ui-${name}-${randomBytes(4).toString("hex")}@example.test`;
}

export function compose(...args: string[]): string {
  const result = spawnSync("docker", ["compose", ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error(`docker compose ${args[0]} failed: ${result.stderr}`);
  return result.stdout;
}

export async function signUp(
  page: Page,
  address: string,
  workspaceName = "UI Test Workspace",
): Promise<string> {
  await page.goto("/sign-up");
  await page.getByLabel("Email").fill(address);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByLabel("Workspace name").fill(workspaceName);
  await page.getByRole("button", { name: "Create your workspace" }).click();
  await page.waitForURL(/\/workspaces\/[0-9a-f-]{36}$/);
  await expect(
    page.getByRole("heading", { level: 1, name: workspaceName }),
  ).toBeVisible();
  return page.url().split("/workspaces/")[1]!;
}

export async function logIn(
  page: Page,
  address: string,
  password = PASSWORD,
): Promise<void> {
  if (new URL(page.url()).pathname !== "/login") await page.goto("/login");
  await page.getByLabel("Email").fill(address);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
}

export const errorBanner = (page: Page) => page.locator(".banner[role=alert]");

const NAV_MENUS: Record<string, string> = {
  "User pools": "User management",
  "User activity": "User management",
  Connections: "Third-party services",
  Webhooks: "Third-party services",
};

export async function openSection(page: Page, label: string): Promise<void> {
  const nav = page.getByRole("navigation", { name: "Workspace" });
  const menu = NAV_MENUS[label];
  if (menu) {
    const toggle = nav.getByRole("button", { name: menu });
    if ((await toggle.getAttribute("aria-expanded")) !== "true")
      await toggle.click();
  }
  await nav.getByRole("link", { name: label, exact: true }).click();
}

export async function openAccountMenu(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^Account: / }).click();
}

export async function logOut(page: Page): Promise<void> {
  await openAccountMenu(page);
  await page
    .locator(".dropdown-panel")
    .getByRole("button", { name: "Log out" })
    .click();
}

export async function openAccount(page: Page): Promise<void> {
  await openAccountMenu(page);
  await page
    .locator(".dropdown-panel")
    .getByRole("button", { name: "Account" })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Your account" }),
  ).toBeVisible();
}

export const accountDialog = (page: Page) =>
  page.getByRole("dialog", { name: "Your account" });

export async function expectNothingStored(page: Page): Promise<void> {
  const stored = await page.evaluate(() => ({
    local: localStorage.length,
    session: sessionStorage.length,
  }));
  expect(stored).toEqual({ local: 0, session: 0 });
}

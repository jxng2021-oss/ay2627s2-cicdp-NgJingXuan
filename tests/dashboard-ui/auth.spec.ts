import { expect, test } from "@playwright/test";
import {
  email,
  errorBanner,
  expectNothingStored,
  logIn,
  logOut,
  accountDialog,
  openAccount,
  openSection,
  PASSWORD,
  signUp,
} from "./helpers";

test("sign up lands on the new workspace, and log out ends the session", async ({
  page,
}) => {
  const address = email("signup");
  await signUp(page, address, "Signup Workspace");

  await expect(page.getByText("Owner", { exact: true }).first()).toBeVisible();
  await expectNothingStored(page);
  await logOut(page);
  await page.waitForURL("**/login");

  await page.goto("/workspaces");
  await page.waitForURL("**/login?next=%2Fworkspaces");
  await logIn(page, address);
  await page.waitForURL(/\/workspaces$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Your workspaces" }),
  ).toBeVisible();
});

test("a wrong password gets the same message as an unknown email", async ({
  page,
}) => {
  const address = email("wrongpw");
  await signUp(page, address);
  await logOut(page);
  await page.waitForURL("**/login");

  await logIn(page, address, "not-the-right-password");
  await expect(errorBanner(page)).toContainText("Wrong email or password");
  const wrong = await errorBanner(page).textContent();
  await page.reload();
  await logIn(page, email("nobody"), "not-the-right-password");
  await expect(errorBanner(page)).toContainText("Wrong email or password");
  const unknown = await errorBanner(page).textContent();

  expect(unknown).toBe(wrong);
});

test("an expired session mid-use shows a clear message, and logging in returns to the page", async ({
  page,
  context,
}) => {
  const address = email("expired");
  const workspace = await signUp(page, address);
  await openSection(page, "API keys");
  await expect(page.getByRole("heading", { name: "API keys" })).toBeVisible();

  await context.clearCookies();
  await openSection(page, "Secrets");

  await expect(
    page.getByRole("heading", { name: "Session ended" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Log in again" }).click();
  await page.waitForURL(
    `**/login?next=${encodeURIComponent(`/workspaces/${workspace}/secrets`)}`,
  );
  await logIn(page, address);
  await page.waitForURL(`**/workspaces/${workspace}/secrets`);
  await expect(page.getByRole("heading", { name: "Secrets" })).toBeVisible();
});

test("an expired access cookie is renewed by the gateway: the user notices nothing", async ({
  page,
  context,
}) => {
  await signUp(page, email("silent"));
  await openSection(page, "API keys");
  await expect(page.getByRole("heading", { name: "API keys" })).toBeVisible();

  await context.clearCookies({ name: "scp_session" });
  await openSection(page, "Secrets");

  await expect(page.getByRole("heading", { name: "Secrets" })).toBeVisible();
  await expect(page.getByText("No secrets yet.")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Session ended" }),
  ).toHaveCount(0);
  const names = (await context.cookies()).map((c) => c.name);
  expect(names).toEqual(expect.arrayContaining(["scp_session", "scp_refresh"]));
  await openSection(page, "API keys");
  await page.getByRole("button", { name: "Create API key" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Create API key" });
  await dialog.getByLabel("Name").fill("after-refresh");
  await dialog.getByRole("button", { name: "Create API key" }).click();
  await expect(page.getByText("Copy your new API key now")).toBeVisible();
});

test("a crafted ?next= can't send you to another site", async ({ page }) => {
  const address = email("next");
  await signUp(page, address);
  await logOut(page);
  await page.waitForURL("**/login");

  await page.goto("/login?next=//evil.example/steal");
  await page.getByLabel("Email").fill(address);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();

  await page.waitForURL(/\/workspaces$/);
  expect(new URL(page.url()).host).toBe("localhost:3000");
});

test("change password, then log out everywhere", async ({ page }) => {
  const address = email("account");
  await signUp(page, address);
  await openAccount(page);
  const account = accountDialog(page);
  await account.getByRole("tab", { name: "Password" }).click();

  await account.getByLabel("Current password").fill(PASSWORD);
  await account.getByLabel("New password").fill("short");
  await account.getByRole("button", { name: "Change password" }).click();
  await expect(account.getByText("Use at least 12 characters.")).toBeVisible();
  await account.getByLabel("New password").fill(`${PASSWORD}-new`);
  await account.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByText("Password changed")).toBeVisible();

  await account.getByRole("tab", { name: "Sessions" }).click();
  await account.getByRole("button", { name: "Log out everywhere" }).click();
  await page
    .getByRole("dialog", { name: "Log out everywhere" })
    .getByRole("button", { name: "Log out everywhere" })
    .click();
  await page.waitForURL("**/login");
  await logIn(page, address, `${PASSWORD}-new`);
  await page.waitForURL(/\/workspaces$/);
});

test("logging in opens the workspace picker, not a workspace", async ({
  page,
}) => {
  const address = email("picker");
  const workspace = await signUp(page, address, "Picker Workspace");
  await logOut(page);
  await page.waitForURL("**/login");

  await logIn(page, address);
  await page.waitForURL(/\/workspaces$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Your workspaces" }),
  ).toBeVisible();
  await page
    .getByRole("list", { name: "Your workspaces" })
    .getByRole("link", { name: /Picker Workspace/ })
    .click();
  await page.waitForURL(`**/workspaces/${workspace}`);

  const switcher = page.getByRole("button", {
    name: /^Workspace: Picker Workspace/,
  });
  await expect(switcher).toContainText("Owner");
  await switcher.click();
  await page
    .getByRole("link", { name: "All workspaces and new workspace" })
    .click();
  await page.waitForURL(/\/workspaces$/);
});

test("create a second workspace and switch between them from the navbar", async ({
  page,
}) => {
  const first = await signUp(page, email("multi"), "First Workspace");
  await page.getByRole("link", { name: "Back to workspaces" }).click();
  await page.waitForURL(/\/workspaces$/);
  await page.getByRole("button", { name: "Create workspace" }).click();
  const dialog = page.getByRole("dialog", { name: "Create workspace" });
  await dialog.getByLabel("Workspace name").fill("Second Workspace");
  await dialog.getByRole("button", { name: "Create workspace" }).click();
  await page.waitForURL(/\/workspaces\/[0-9a-f-]{36}$/);
  await expect(
    page.getByRole("button", { name: /^Workspace: Second Workspace/ }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: /^Workspace: Second Workspace/ })
    .click();
  await page.getByRole("link", { name: /First Workspace/ }).click();
  await page.waitForURL(`**/workspaces/${first}`);
  await expect(
    page.getByRole("button", { name: /^Workspace: First Workspace/ }),
  ).toBeVisible();
});

test("the theme switch overrides the system theme and is remembered", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await signUp(page, email("theme"));
  const theme = page.getByRole("group", { name: "Theme" });
  await theme.getByRole("button", { name: "Light" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const background = () =>
    page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(await background()).toBe("rgb(255, 255, 255)");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(theme.getByRole("button", { name: "Light" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("link", { name: "secure-cloud" }).click();
  await page.waitForURL((url) => url.pathname === "/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await background()).toBe("rgb(255, 255, 255)");
  await page.goBack();

  await theme.getByRole("button", { name: "System" }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.*/);
  await expectNothingStored(page);
});

test("account page: display name, sessions, leaving and deleting the account", async ({
  page,
  browser,
}) => {
  const address = email("profile");
  await signUp(page, address, "Profile Workspace");
  const laptop = await (await browser.newContext()).newPage();
  await logIn(laptop, address);
  await laptop.waitForURL(/\/workspaces$/);

  await openAccount(page);
  const account = accountDialog(page);
  await account.getByLabel("Display name").fill("Ada Lovelace");
  await account.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText("Display name saved")).toBeVisible();
  await account.getByRole("button", { name: "Close" }).click();
  await expect(
    page.getByRole("button", { name: /^Account: Ada Lovelace/ }),
  ).toBeVisible();

  await openAccount(page);
  await account.getByRole("tab", { name: "Sessions" }).click();
  const sessions = account.getByRole("region", { name: "Sessions" });
  await expect(sessions.getByRole("row")).toHaveCount(3);
  await sessions.getByRole("button", { name: "End session" }).click();
  await page
    .getByRole("dialog", { name: "End session" })
    .getByRole("button", { name: "End session" })
    .click();
  await expect(page.getByText("Session ended")).toBeVisible();
  await laptop.goto("/workspaces");
  await laptop.waitForURL("**/login?next=%2Fworkspaces");

  await account.getByRole("tab", { name: "Delete account" }).click();
  await account.getByRole("button", { name: "Delete account" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete account" });
  await dialog.getByLabel("Password").fill(PASSWORD);
  await dialog.getByRole("button", { name: "Delete account" }).click();
  await expect(
    dialog.getByText(/only owner of Profile Workspace/),
  ).toBeVisible();
});

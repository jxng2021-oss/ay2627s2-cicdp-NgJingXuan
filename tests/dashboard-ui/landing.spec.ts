import { expect, test } from "@playwright/test";
import { email, signUp } from "./helpers";

test("visitors get one primary action; it opens the sign up page", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Your apps call any API without ever holding the key",
  );
  const bar = page.getByRole("banner");
  await expect(bar.getByRole("link", { name: "Log in" })).toBeVisible();
  await expect(bar.getByRole("link", { name: "Open dashboard" })).toHaveCount(
    0,
  );

  const ctas = page.getByRole("main").getByRole("link", {
    name: "Create your workspace",
  });
  await expect(ctas).toHaveCount(2);

  await bar.getByRole("link", { name: "Create workspace" }).click();
  await page.waitForURL("**/sign-up");
  await expect(
    page.getByRole("heading", { level: 1, name: "Create your workspace" }),
  ).toBeVisible();
});

test("signed in users see Open dashboard, which opens the workspace picker", async ({
  page,
}) => {
  const id = await signUp(page, email("landing"), "Landing Workspace");
  await page.goto("/");
  const bar = page.getByRole("banner");
  await expect(bar.getByRole("link", { name: "Create workspace" })).toHaveCount(
    0,
  );

  await bar.getByRole("link", { name: "Open dashboard" }).click();
  await page.waitForURL(/\/workspaces$/);
  await page
    .getByRole("list", { name: "Your workspaces" })
    .getByRole("link", { name: /Landing Workspace/ })
    .click();
  await page.waitForURL(`**/workspaces/${id}`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Landing Workspace" }),
  ).toBeVisible();
});

test("on a phone the links open in a full height menu", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Site" })).toBeHidden();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  const toggle = page.getByRole("button", { name: "Open menu" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  const menu = page.getByRole("navigation", { name: "Menu" });
  await expect(menu).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Close menu" }),
  ).toHaveAttribute("aria-expanded", "true");

  await menu.getByRole("link", { name: "How it works" }).click();
  await expect(menu).toBeHidden();
  await expect(page).toHaveURL(/#how-it-works$/);
});

test("the tagline lights up word by word as it scrolls into view", async ({
  page,
}) => {
  await page.goto("/");
  const words = page.locator(".tagline-word");
  await expect(words.first()).toHaveAttribute("data-on", "false");
  await page.locator(".tagline").scrollIntoViewIfNeeded();
  await page.mouse.wheel(0, 400);
  await expect(words.last()).toHaveAttribute("data-on", "true");
  await expect(page.locator(".tagline .sr-only")).toHaveText(
    "Your keys stay in the vault. Your apps only ever hold a key you can revoke at any time.",
  );
});

test("the FAQ answers open and close from the keyboard", async ({ page }) => {
  await page.goto("/");
  const question = page.getByText(
    "Can anyone read a secret back after I save it?",
  );
  await question.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Secret values are write only/)).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Secret values are write only/)).toBeHidden();
});

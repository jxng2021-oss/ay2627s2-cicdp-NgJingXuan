import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { email, openAccount, openSection, signUp } from "./helpers";

async function expectAccessible(page: Page, label: string) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const problems = results.violations.map(
    (v) =>
      `${label}: ${v.id} (${v.nodes.length}) ${v.help}: ${v.nodes
        .slice(0, 3)
        .map((n) => n.target.join(" "))
        .join(", ")}`,
  );
  expect(problems).toEqual([]);
}

for (const size of [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`the main pages pass axe (${size.name})`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto("/");
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 400) {
        window.scrollTo(0, y);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    });
    await page.waitForTimeout(800);
    await expectAccessible(page, "landing");
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible();
    await expectAccessible(page, "login");
    await page.goto("/sign-up");
    await expectAccessible(page, "sign-up");

    await signUp(page, email(`a11y-${size.name}`), "Accessible Workspace");
    await expectAccessible(page, "overview");
    for (const [section, heading] of [
      ["API keys", "API keys"],
      ["Secrets", "Secrets"],
      ["Files", "Files"],
      ["Connections", "Connections"],
      ["User pools", "User pools"],
      ["User activity", "User activity"],
      ["Feature flags", "Feature flags"],
      ["Audit log", "Audit log"],
      ["Settings", "Settings"],
    ]) {
      if (size.name === "mobile")
        await page.getByRole("button", { name: "Open menu" }).click();
      await openSection(page, section!);
      await expect(
        page.getByRole("heading", { level: 1, name: heading }),
      ).toBeVisible();
      await expectAccessible(page, section!);
    }
    if (size.name === "mobile")
      await page.getByRole("button", { name: "Open menu" }).click();
    await openSection(page, "Connections");
    await page.getByRole("link", { name: "Create connection" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Create connection" }),
    ).toBeVisible();
    await expectAccessible(page, "new connection");
    await page.getByRole("button", { name: /^Workspace: / }).click();
    await expectAccessible(page, "workspace switcher");
    await page.keyboard.press("Escape");
    await page.goto("/workspaces");
    await expect(
      page.getByRole("heading", { name: "Your workspaces" }),
    ).toBeVisible();
    await expectAccessible(page, "workspace picker");
    await openAccount(page);
    for (const tab of [
      "Profile",
      "Password",
      "Sessions",
      "Workspaces",
      "Delete account",
    ]) {
      await page
        .getByRole("dialog", { name: "Your account" })
        .getByRole("tab", { name: tab })
        .click();
      await expectAccessible(page, `account: ${tab}`);
    }
  });
}

test("dialogs work from the keyboard: focus moves in, Escape closes them", async ({
  page,
}) => {
  await signUp(page, email("keyboard"));
  await openSection(page, "API keys");
  await page.getByRole("button", { name: "Create API key" }).focus();
  await page.keyboard.press("Enter");

  const dialog = page.getByRole("dialog", { name: "Create API key" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Name")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

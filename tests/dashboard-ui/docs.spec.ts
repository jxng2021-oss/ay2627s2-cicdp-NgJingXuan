import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const PAGES = [
  ["/docs", "Quickstart"],
  ["/docs/connections", "Calling outside APIs"],
  ["/docs/files", "Files"],
  ["/docs/user-pools", "User sign in"],
  ["/docs/roles", "Roles and permissions"],
  ["/docs/express", "Express helpers"],
  ["/docs/errors", "Errors"],
] as const;

test("the landing page links to the docs; Next walks through every page", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Site" })
    .getByRole("link", { name: "Docs" })
    .click();
  await page.waitForURL("**/docs");

  for (const [path, title] of PAGES) {
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
    await expect(
      page
        .getByRole("navigation", { name: "SDK docs" })
        .getByRole("link", { name: title }),
    ).toHaveAttribute("aria-current", "page");
    const next = page.locator(".docs-next");
    if ((await next.count()) > 0) await next.click();
  }
});

test("examples have copy buttons, and the quickstart never shows a real key", async ({
  page,
}) => {
  await page.goto("/docs");
  await expect(
    page.getByRole("button", { name: "Copy server.js" }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("SECURE_CLOUD_API_KEY=paste_your_key_here"),
  ).toBeVisible();
  await expect(page.getByText(/sk_(live|local|test)_[0-9a-f]{8}/)).toHaveCount(
    0,
  );
});

test("every docs page passes axe, on desktop and a phone", async ({ page }) => {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const [path] of PAGES) {
      await page.goto(path);
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      expect(
        results.violations.map((v) => `${path} @${width}: ${v.id} ${v.help}`),
      ).toEqual([]);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(
        overflow,
        `${path} scrolls sideways at ${width}px`,
      ).toBeLessThanOrEqual(0);
    }
  }
});

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function adminPassword(): string {
  const env = readFileSync(`${REPO_ROOT}.local/demo-shop.env`, "utf8");
  const match = /^SHOP_ADMIN_PASSWORD=(.+)$/m.exec(env);
  if (!match?.[1])
    throw new Error("Run LOCAL_DEV_MODE=true pnpm demo:setup first");
  return match[1].trim();
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==",
  "base64",
);

let admin: Page;

test.beforeAll(async ({ browser }) => {
  admin = await (await browser.newContext()).newPage();
  await admin.goto("/admin");
  await admin.waitForURL("**/admin-login?next=%2Fadmin");
  await admin.getByLabel("Admin password").fill(adminPassword());
  await admin.getByRole("button", { name: "Sign in" }).click();
  await admin.waitForURL(/\/admin$/);
});
test.afterAll(async () => admin.context().close());

const SHOPPER_PASSWORD = `shopper-${randomBytes(9).toString("base64url")}`;

async function signUpShopper(page: Page): Promise<string> {
  const email = `shopper-${randomBytes(4).toString("hex")}@example.test`;
  await page.goto("/account/sign-up");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(SHOPPER_PASSWORD);
  await page.getByRole("button", { name: "Create Account" }).click();
  await page.waitForURL("**/account/orders");
  await expect(page.getByText(`Signed in as ${email}.`)).toBeVisible();
  return email;
}

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

test("admin needs the admin login, and shows the platform is connected", async ({
  page,
}) => {
  await page.goto("/admin/orders");
  await page.waitForURL("**/admin-login?next=%2Fadmin%2Forders");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Enter the admin password.")).toBeVisible();
  await page.getByLabel("Admin password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("That isn't the admin password.")).toBeVisible();
  expect(page.url()).toContain("/admin-login");

  await admin.goto("/admin");
  await expect(admin.getByRole("heading", { name: "Platform" })).toBeVisible();
  for (const card of ["API key", "Payment key", "Payments connection"]) {
    await expect(admin.getByRole("region", { name: card })).not.toContainText(
      /Missing|Not set up|Not working/,
    );
  }
});

test("a product photo is uploaded, stored on the platform, and shown in the shop", async ({
  page,
}) => {
  await admin.goto("/admin/products");
  await admin.getByTestId("photo-field-notebook").setInputFiles({
    name: "notebook.png",
    mimeType: "image/png",
    buffer: PNG,
  });
  await expect(admin.getByText("Photo uploaded")).toBeVisible();

  await page.goto("/");
  const photo = page.getByRole("img", { name: "Field Notebook" });
  await expect(photo).toBeVisible();
  await expect
    .poll(() => photo.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(1);
  await expectAccessible(page);
});

test("checkout pays through the platform's connection and saves a signed receipt", async ({
  page,
}) => {
  await signUpShopper(page);
  await page.goto("/products/field-notebook");
  await expectAccessible(page);
  await page.getByLabel("Quantity").selectOption("2");
  await page.getByRole("button", { name: "Buy Now" }).click();

  await page.waitForURL(/\/orders\/[0-9a-f-]{36}$/);
  await expect(
    page.getByRole("heading", { name: "Thank you for your order" }),
  ).toBeVisible();
  await expect(page.getByText("S$36.00").first()).toBeVisible();
  await expect(page.getByText(/^ch_[0-9a-f]{32}$/)).toBeVisible();
  await expect(
    page.getByText("Stored encrypted on secure-cloud"),
  ).toBeVisible();
  const receiptId = page.url().split("/orders/")[1]!;

  await admin.goto("/admin/orders");
  await expect(
    admin.getByRole("row", { name: /receipt-.*\.json/ }).first(),
  ).toBeVisible();
  const asImage = await page.request.get(`/images/${receiptId}`);
  expect(asImage.status()).toBe(404);
});

test("the platform's payment policy blocks an order over S$500, before the key is used", async ({
  page,
}) => {
  await signUpShopper(page);
  await page.goto("/products/studio-headphones");
  await page.getByRole("button", { name: "Buy Now" }).click();
  const banner = page.locator(".banner[role=alert]");
  await expect(banner).toContainText("Blocked by the payment policy");
  await expect(banner).toContainText(/Request ID [0-9a-f-]{36}/);
  expect(page.url()).toContain("/products/studio-headphones");
});

test("the audit trail shows the payment, the platform reading its key to inject it, and the files, with request IDs", async () => {
  await admin.goto("/admin/activity");
  for (const action of [
    "proxy_connection.used",
    "proxy_connection.denied",
    "secret.read",
    "file.uploaded",
  ]) {
    await expect(
      admin.getByRole("cell", { name: action, exact: true }).first(),
    ).toBeVisible();
  }
  const requestId = await admin
    .getByRole("row", { name: /proxy_connection\.used/ })
    .first()
    .getByRole("cell")
    .last()
    .textContent();
  expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);

  await admin.getByLabel("Action").selectOption("secret.read");
  await admin.getByRole("button", { name: "Apply Filter" }).click();
  await expect(
    admin.getByRole("cell", { name: "file.uploaded", exact: true }),
  ).toHaveCount(0);
  await expect(
    admin.getByRole("cell", { name: "secret.read", exact: true }).first(),
  ).toBeVisible();
});

test("uploads from other sites, and non-images, are refused", async () => {
  const forged = await admin.request.post("/admin/products/enamel-mug/photo", {
    headers: { "content-type": "image/png", origin: "https://evil.example" },
    data: PNG,
  });
  expect(forged.status()).toBe(403);

  const origin = new URL(admin.url()).origin;
  const html = await admin.request.post("/admin/products/enamel-mug/photo", {
    headers: { "content-type": "text/html", origin, "x-demo-shop": "upload" },
    data: "<script>alert(1)</script>",
  });
  expect(html.status()).toBe(415);
});

test("shoppers: accounts from the platform's user pool, own orders only, silent refresh, sign out", async ({
  page,
  browser,
}) => {
  await page.goto("/products/field-notebook");
  await page.getByRole("button", { name: "Buy Now" }).click();
  await expect(
    page.getByRole("link", { name: "Sign in to buy" }),
  ).toBeVisible();

  const email = await signUpShopper(page);
  await expectAccessible(page);
  await page.goto("/products/field-notebook");
  await page.getByRole("button", { name: "Buy Now" }).click();
  await page.waitForURL(/\/orders\/[0-9a-f-]{36}$/);
  const order = new URL(page.url()).pathname;
  await page.getByRole("link", { name: "My Orders" }).click();
  await expect(
    page.getByRole("list", { name: "Your orders" }).getByRole("link"),
  ).toHaveCount(1);

  const cookies = await page.context().cookies();
  const access = cookies.find((c) => c.name === "shop_access");
  expect(access?.httpOnly).toBe(true);
  expect(access?.value.split(".")).toHaveLength(3);
  expect(cookies.find((c) => c.name === "shop_refresh")?.httpOnly).toBe(true);

  await page.context().clearCookies({ name: "shop_access" });
  await page.goto("/account/orders");
  await expect(page.getByText(`Signed in as ${email}.`)).toBeVisible();
  const renewed = await page.context().cookies();
  expect(renewed.find((c) => c.name === "shop_access")).toBeDefined();
  expect(renewed.find((c) => c.name === "shop_refresh")?.value).not.toBe(
    cookies.find((c) => c.name === "shop_refresh")?.value,
  );

  const other = await (await browser.newContext()).newPage();
  await signUpShopper(other);
  const response = await other.goto(order);
  expect(response?.status()).toBe(404);
  await other.context().close();

  await page.getByRole("button", { name: "Sign Out" }).click();
  await page.waitForURL((url) => url.pathname === "/");
  await expect(page.getByRole("link", { name: "Sign In" })).toBeVisible();
  await page.goto("/account/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("not-the-password-1");
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page.getByText("Wrong email or password")).toBeVisible();
});

test("the sale banner follows the platform's sale-banner feature flag", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Sale" })).toContainText(
    "Holiday sale is on.",
  );
});

test("shopper sign in shows its own messages, never the browser's", async ({
  page,
}) => {
  await page.goto("/account/sign-in");
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(
    page.getByText("Enter an email address, like you@example.com."),
  ).toBeVisible();
  await expect(page.getByText("Enter your password.")).toBeVisible();
  expect(page.url()).toContain("/account/sign-in");
});

test("the admin signs out", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/admin-login");
  await page.getByLabel("Admin password").fill(adminPassword());
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/admin$/);
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL("**/admin-login");
  await page.goto("/admin");
  await page.waitForURL("**/admin-login?next=%2Fadmin");
  await page.context().close();
});

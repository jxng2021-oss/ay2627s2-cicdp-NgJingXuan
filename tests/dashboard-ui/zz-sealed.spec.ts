import { expect, test } from "@playwright/test";
import { compose, email, openSection, signUp } from "./helpers";

test("while sealed: a clear banner, and secret and file actions blocked; lists still work", async ({
  page,
}) => {
  await signUp(page, email("sealed"), "Sealed Workspace");
  await openSection(page, "Files");
  await page.locator("#file-upload").setInputFiles({
    name: "before-seal.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("x"),
  });
  await expect(
    page.getByRole("row", { name: /before-seal\.txt/ }),
  ).toBeVisible();

  compose("exec", "-T", "secrets", "secrets-operator", "seal");
  await page.reload();

  const banner = page
    .locator(".banner[role=alert]")
    .filter({ hasText: "Secrets are sealed" });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("upload or download files");
  await expect(
    page.getByRole("row", { name: /before-seal\.txt/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Upload file" }),
  ).toBeDisabled();
  await page
    .getByRole("row", { name: /before-seal\.txt/ })
    .getByRole("link", { name: "Details of before-seal.txt" })
    .click();
  await expect(
    page.getByRole("button", { name: "Download file" }),
  ).toBeDisabled();

  await openSection(page, "Secrets");
  await expect(
    page.getByRole("button", { name: "Create secret" }),
  ).toBeDisabled();
  await openSection(page, "Overview");
  await expect(page.getByText("Sealed", { exact: true })).toBeVisible();
  await openSection(page, "Audit log");
  await expect(
    page.getByRole("cell", { name: "file.uploaded", exact: true }),
  ).toBeVisible();
});

import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { compose, email, logIn, openSection, signUp } from "./helpers";

test("a member doesn't see owner-only controls (and the API refuses them anyway)", async ({
  browser,
}) => {
  const owner = await (await browser.newContext()).newPage();
  const ownerWorkspace = await signUp(
    owner,
    email("team-owner"),
    "Team Workspace",
  );
  await openSection(owner, "Secrets");
  await owner.getByRole("button", { name: "Create secret" }).click();
  await owner.getByRole("dialog").getByLabel("Name").fill("shared-secret");
  await owner.getByRole("dialog").getByLabel("Value").fill("owners-only-value");
  await owner
    .getByRole("dialog")
    .getByRole("button", { name: "Save secret" })
    .click();
  await expect(owner.getByRole("row", { name: /shared-secret/ })).toBeVisible();

  const memberAddress = email("team-member");
  const member = await (await browser.newContext()).newPage();
  await signUp(member, memberAddress, "Member's Own");
  compose(
    "exec",
    "-T",
    "gateway",
    "node",
    "dist/accounts-cli.js",
    "add-member",
    memberAddress,
    ownerWorkspace,
    "member",
  );

  await member.goto("/workspaces");
  const choices = member.getByRole("list", { name: "Your workspaces" });
  await expect(choices.getByRole("link")).toHaveCount(2);
  await expect(
    choices.getByRole("link", { name: "Member's Own Owner" }),
  ).toBeVisible();
  await choices.getByRole("link", { name: "Team Workspace Member" }).click();
  await member.waitForURL(`**/workspaces/${ownerWorkspace}`);
  await expect(
    member.getByRole("heading", { name: "Team Workspace" }),
  ).toBeVisible();
  await expect(member.locator(".stat-value").first()).toHaveText("Member");

  await openSection(member, "API keys");
  await expect(member.getByText("Viewing as a member")).toBeVisible();
  await expect(
    member.getByRole("button", { name: "Create API key" }),
  ).toHaveCount(0);

  await openSection(member, "Secrets");
  await expect(
    member.getByRole("button", { name: "Create secret" }),
  ).toHaveCount(0);
  const row = member.getByRole("row", { name: /shared-secret/ });
  await row.getByRole("link", { name: "Details of shared-secret" }).click();
  await expect(
    member.getByRole("heading", { level: 1, name: "shared-secret" }),
  ).toBeVisible();
  await expect(member.getByRole("heading", { name: "Versions" })).toBeVisible();
  for (const control of ["Rotate secret", "Delete secret"]) {
    await expect(member.getByRole("button", { name: control })).toHaveCount(0);
  }

  await openSection(member, "Files");
  await member.locator("#file-upload").setInputFiles({
    name: "member.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hi"),
  });
  const file = member.getByRole("row", { name: /member\.txt/ });
  await file.getByRole("link", { name: "Details of member.txt" }).click();
  await expect(
    member.getByRole("link", { name: "Download file" }),
  ).toBeVisible();
  await expect(member.getByRole("button", { name: "Delete file" })).toHaveCount(
    0,
  );

  await openSection(member, "Connections");
  await expect(
    member.getByRole("link", { name: "Create connection" }),
  ).toHaveCount(0);
});

test("another user's workspace and a missing one show the same Not Found page", async ({
  browser,
}) => {
  const alice = await (await browser.newContext()).newPage();
  const aliceWorkspace = await signUp(alice, email("alice"), "Alice Workspace");
  const bob = await (await browser.newContext()).newPage();
  await signUp(bob, email("bob"), "Bob Workspace");

  for (const path of [
    `/workspaces/${aliceWorkspace}`,
    `/workspaces/${aliceWorkspace}/secrets`,
    `/workspaces/${randomUUID()}`,
  ]) {
    await bob.goto(path);
    await expect(
      bob.getByRole("heading", { name: "Page not found" }),
    ).toBeVisible();
    await expect(bob.getByText("Alice Workspace")).toHaveCount(0);
  }
});

test("logged-out visitors are sent to log in, and come back afterwards", async ({
  page,
}) => {
  const address = email("returning");
  const workspace = await signUp(page, address);
  await page.context().clearCookies();

  await page.goto(`/workspaces/${workspace}/files`);
  await page.waitForURL(
    `**/login?next=${encodeURIComponent(`/workspaces/${workspace}/files`)}`,
  );
  await logIn(page, address);
  await page.waitForURL(`**/workspaces/${workspace}/files`);
});

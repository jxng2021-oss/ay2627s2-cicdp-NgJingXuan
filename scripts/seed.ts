import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  fail,
  LOCAL_OWNER_EMAIL,
  localAccount,
  OWNER_FILE,
  ownedWorkspace,
  requireLocalDevMode,
  saveOwner,
  savedOwnerPassword,
} from "./dashboard-session.ts";

const OUTPUT = ".local/seed-users.json";
const MEMBER_EMAIL = "demo-member@example.test";

requireLocalDevMode("The seed");

const savedMember = existsSync(OUTPUT)
  ? (
      JSON.parse(readFileSync(OUTPUT, "utf8")) as {
        member?: { email?: string; password?: string };
      }
    ).member
  : undefined;

const ownerAccount = await localAccount(
  LOCAL_OWNER_EMAIL,
  savedOwnerPassword(),
  "Demo workspace",
);
saveOwner(ownerAccount);
const workspace = await ownedWorkspace(ownerAccount, "Demo workspace");
const memberAccount = await localAccount(
  MEMBER_EMAIL,
  savedMember?.email === MEMBER_EMAIL ? savedMember.password : undefined,
  "Demo member's own",
);
const owner = ownerAccount.session;
const member = memberAccount.session;
const alreadyMember = memberAccount.workspaces.some((w) => w.id === workspace);

const added = alreadyMember
  ? { status: 0, stderr: "" }
  : spawnSync(
      "docker",
      [
        "compose",
        "exec",
        "-T",
        "gateway",
        "node",
        "dist/accounts-cli.js",
        "add-member",
        MEMBER_EMAIL,
        workspace,
        "member",
      ],
      { encoding: "utf8" },
    );
if (added.status !== 0) fail(`add-member failed: ${added.stderr}`);

const ws = `/workspaces/${workspace}`;
for (const name of [
  "demo-db-password",
  "demo-payments-key",
  "demo-smtp-token",
]) {
  await owner.call("PUT", `${ws}/secrets/${name}`, {
    value: `fake-${name}-${randomBytes(8).toString("hex")}`,
  });
}
await owner.call("POST", `${ws}/secrets/demo-db-password/rotate`, {
  value: `fake-rotated-${randomBytes(8).toString("hex")}`,
});
await owner.call(
  "POST",
  `${ws}/files`,
  undefined,
  Buffer.from("A demo file, uploaded by the seed.\n"),
);
await member.refreshCsrf();
await member.call(
  "POST",
  `${ws}/files`,
  undefined,
  Buffer.from("Uploaded by the demo member.\n"),
);
await owner.call("POST", `${ws}/api-keys`, { name: "demo key" });

mkdirSync(".local", { recursive: true });
writeFileSync(
  OUTPUT,
  `${JSON.stringify(
    {
      workspace,
      member: { email: MEMBER_EMAIL, password: memberAccount.password },
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);
console.log(
  `✔ Demo workspace ${workspace}, with fake secrets, files and an API key.`,
);
console.log(`  owner:  ${LOCAL_OWNER_EMAIL}  (password in ${OWNER_FILE})`);
console.log(`  member: ${MEMBER_EMAIL}  (password in ${OUTPUT})`);

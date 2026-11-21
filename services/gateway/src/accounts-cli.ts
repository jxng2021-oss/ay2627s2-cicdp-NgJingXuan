import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import { AuditClient, httpAuditTransport } from "./audit.js";
import { loadConfig } from "./config.js";
import { insertMembership } from "./models/membership.model.js";
import { findUserByEmail } from "./models/user.model.js";
import {
  normaliseEmail,
  setPassword,
  userEvent,
} from "./services/auth.service.js";
import { connectDatabase } from "./db/client.js";
import { findTenant } from "./models/platform.model.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const [command, ...args] = process.argv.slice(2);

function usage(): never {
  console.error(
    "Usage:\n  node dist/accounts-cli.js add-member <email> <workspace-id> <owner|member>\n  node dist/accounts-cli.js reset-password <email>",
  );
  process.exit(2);
}

if (command !== "add-member" && command !== "reset-password") usage();
if (command === "add-member" && process.env.NODE_ENV === "production") {
  console.error(
    "add-member is for local testing only (there are no invites yet).",
  );
  process.exit(1);
}

const config = loadConfig();
const database = connectDatabase(config.databaseUrl);
const transport = httpAuditTransport({
  url: config.auditUrl,
  service: "gateway",
  token: config.auditToken,
  timeoutMs: config.auditTimeoutMs,
});
const audit = new AuditClient(transport.transport);
const log = Fastify({ logger: { level: "error", stream: process.stderr } }).log;

let exitCode = 0;
try {
  const email = normaliseEmail(args[0] ?? "");
  const user = await findUserByEmail(database.db, email);
  if (!user) throw new Error(`No user with the email ${email}`);

  if (command === "add-member") {
    const [, workspaceId = "", role = ""] = args;
    if (!UUID.test(workspaceId) || (role !== "owner" && role !== "member"))
      usage();
    if (!(await findTenant(database.db, workspaceId))) {
      throw new Error(`No workspace ${workspaceId}`);
    }
    const added = await insertMembership(database.db, {
      userId: user.id,
      tenantId: workspaceId,
      role,
    });
    if (!added)
      throw new Error("That user is already a member of this workspace");
    await audit.record(
      {
        ...userEvent(undefined, "membership.added", undefined, workspaceId),
        actorType: "operator",
        actorId: undefined,
        resourceId: user.id,
      },
      log,
    );
    console.log(`Added ${email} to ${workspaceId} as ${role}.`);
  } else {
    const password = randomBytes(18).toString("base64url");
    await setPassword(database.db, audit, undefined, log, user, password);
    console.log(
      `New password for ${email} (shown once; every session was ended):\n${password}`,
    );
  }
} catch (error) {
  console.error(
    `Failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  exitCode = 1;
} finally {
  await transport.close();
  await database.close();
}
process.exit(exitCode);

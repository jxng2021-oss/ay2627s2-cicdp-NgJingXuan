import { chmod, rm } from "node:fs/promises";
import { buildApp } from "./app.js";
import { AuditClient, httpAuditTransport } from "./audit.js";
import { loadConfig } from "./config.js";
import { connectDatabase } from "./db/client.js";
import { buildOperatorApp } from "./operator-app.js";
import { SealManager } from "./seal/seal-manager.js";

const config = loadConfig();
const database = connectDatabase(config.databaseUrl);

const auditHttp = httpAuditTransport({
  url: config.auditUrl,
  service: "secrets",
  token: config.auditToken,
  timeoutMs: config.auditTimeoutMs,
});
const audit = new AuditClient(auditHttp.transport);

const seal = new SealManager(database.db, config.seal, Date.now, (action) =>
  audit.record({ action, outcome: "success", actorType: "operator" }, app.log),
);
await seal.load();

const app = buildApp({
  ...config,
  db: database.db,
  keyProvider: seal,
  audit,
  logger: {
    redact: {
      paths: ["req.headers.authorization", "req.body", "res.body"],
      censor: "[redacted]",
    },
  },
});

const operator = buildOperatorApp(seal);

app.addHook("onClose", async () => {
  await operator.close();
  await seal.seal("shutdown");
  await auditHttp.close();
  await database.close();
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutting down");
    setTimeout(() => {
      app.log.error("shutdown took too long, exiting");
      process.exit(1);
    }, config.shutdownTimeoutMs).unref();
    void app.close();
  });
}

await rm(config.operatorSocket, { force: true });
await operator.listen({ path: config.operatorSocket });
await chmod(config.operatorSocket, 0o600);

await app.listen({ host: config.host, port: config.port });
app.log.info(
  { seal: seal.state },
  seal.state === "uninitialised"
    ? "secrets service started: NOT INITIALISED (an operator must run `init`)"
    : "secrets service started SEALED: an operator must unseal it with 3 shares",
);

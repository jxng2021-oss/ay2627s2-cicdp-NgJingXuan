import { buildApp } from "./app.js";
import { AuditClient, httpAuditTransport } from "./audit.js";
import { loadConfig } from "./config.js";
import { connectDatabase } from "./db/client.js";
import { connectRedis, RedisRateLimitStore } from "./rate-limit.js";

const config = loadConfig();
const database = connectDatabase(config.databaseUrl);
const redis = connectRedis(config.redisUrl);

const auditHttp = httpAuditTransport({
  url: config.auditUrl,
  service: "gateway",
  token: config.auditToken,
  timeoutMs: config.auditTimeoutMs,
});
const audit = new AuditClient(auditHttp.transport);

const app = buildApp({
  ...config,
  db: database.db,
  rateLimitStore: new RedisRateLimitStore(redis),
  audit,
  logger: {
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        'req.headers["x-api-key"]',
        "req.body",
        "res.body",
      ],
      censor: "[redacted]",
    },
  },
});

redis.on("error", () => undefined);

app.addHook("onClose", async () => {
  await auditHttp.close();
  await database.close();
  redis.disconnect();
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

await app.listen({ host: config.host, port: config.port });

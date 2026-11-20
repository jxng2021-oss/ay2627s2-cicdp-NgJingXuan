import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { connectDatabase } from "./db/client.js";

const config = loadConfig();
const database = connectDatabase(config.databaseUrl);

const app = buildApp({
  ...config,
  db: database.db,
  logger: {
    redact: {
      paths: ["req.headers.authorization", "req.body", "res.body"],
      censor: "[redacted]",
    },
  },
});

app.addHook("onClose", () => database.close());

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

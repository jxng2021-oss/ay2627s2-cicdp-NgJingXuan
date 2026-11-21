import { buildApp } from "./app.js";
import { AuditClient } from "./audit.js";
import type { Database } from "./db/client.js";
import { MemoryRateLimitStore } from "./rate-limit.js";

const document = process.argv[2] === "dashboard" ? "dashboard" : "public";

const app = buildApp({
  openApiDocument: document,
  dashboard: {
    origin: "https://dashboard.invalid",
    session: {
      secret: "not-used-for-generating-the-specification",
      accessTtlMs: 1,
      idleTimeoutMs: 1,
      absoluteTimeoutMs: 1,
      refreshGraceMs: 1,
      cookieSecure: true,
    },
    authLimits: { perIp: 1, perEmail: 1 },
  },
  db: {} as Database,
  rateLimitStore: new MemoryRateLimitStore(),
  rateLimits: {
    windowMs: 60_000,
    requestsPerKey: 1,
    uploadsPerKey: 1,
    failedAuthPerIp: 1,
    adminPerIp: 1,
  },
  adminToken: "not-used-for-generating-the-specification",
  apiKeyHashSecret: "not-used-for-generating-the-specification",
  apiKeyPrefix: "sk_docs_",
  storageUrl: "http://storage.invalid",
  secretsUrl: "http://secrets.invalid",
  connectTimeoutMs: 1,
  responseTimeoutMs: 1,
  maxUploadBytes: 1,
  maxSecretBytes: 1,
  server: {
    maxHeaderBytes: 16_384,
    headersTimeoutMs: 1,
    requestTimeoutMs: 1,
    keepAliveTimeoutMs: 1,
    idleTimeoutMs: 1,
  },
  trustProxy: false,
  proxy: { allowedHosts: [], allowPrivateTargets: false },
  audit: new AuditClient(() => Promise.resolve()),
  auditUrl: "http://audit.invalid",
  identityUrl: "http://identity.invalid",
  flagsUrl: "http://flags.invalid",
  auditToken: "not-used-for-generating-the-specification",
});

await app.ready();
process.stdout.write(`${JSON.stringify(app.swagger(), null, 2)}\n`);
await app.close();

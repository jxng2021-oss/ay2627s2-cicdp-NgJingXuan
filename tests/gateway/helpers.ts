import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, afterEach, expect } from "vitest";
import {
  buildApp,
  type GatewayAppOptions,
  type ServerLimits,
} from "../../services/gateway/src/app.js";
import {
  AuditClient,
  type AuditEvent,
} from "../../services/gateway/src/audit.js";
import type { RateLimitSettings } from "../../services/gateway/src/limits.js";
import { MemoryRateLimitStore } from "../../services/gateway/src/rate-limit.js";
import {
  MIGRATIONS_FOLDER,
  type Database,
} from "../../services/gateway/src/db/client.js";
import * as schema from "../../services/gateway/src/db/schema.js";
import type { OAuthSettings } from "../../services/gateway/src/services/oauth.service.js";

export const ADMIN_TOKEN = "test-admin-token-0123456789abcdef0123456789";
export const API_KEY_HASH_SECRET =
  "test-hash-secret-0123456789abcdef0123456789";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

let shared: { db: Database; client: PGlite } | undefined;
afterAll(async () => {
  await shared?.client.close();
  shared = undefined;
});

export async function createTestDatabase(): Promise<{
  db: Database;
  client: PGlite;
}> {
  if (!shared) {
    const client = new PGlite();
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    shared = { db, client };
  } else {
    await shared.client.exec(
      "truncate table sessions, memberships, users, api_keys, tenants cascade",
    );
  }
  return shared;
}

export async function startFakeStorage(
  handler: RequestListener,
): Promise<string> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export function captureLogs(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { stream, text: () => chunks.join("") };
}

export const TEST_RATE_LIMITS: RateLimitSettings = {
  windowMs: 60_000,
  requestsPerKey: 1_000,
  uploadsPerKey: 1_000,
  failedAuthPerIp: 1_000,
  adminPerIp: 1_000,
};

export const TEST_SERVER_LIMITS: ServerLimits = {
  maxHeaderBytes: 16 * 1024,
  headersTimeoutMs: 10_000,
  requestTimeoutMs: 10_000,
  keepAliveTimeoutMs: 5_000,
  idleTimeoutMs: 10_000,
};

export class FakeAudit {
  events: AuditEvent[] = [];
  down = false;
  readonly client = new AuditClient(
    (event) => {
      if (this.down) return Promise.reject(new Error("audit service is down"));
      this.events.push(event);
      return Promise.resolve();
    },
    [1, 1],
  );
}

export const TEST_OAUTH: OAuthSettings = {
  redirectOrigin: "https://api.test",
  google: { clientId: "google-client-id", clientSecret: "google-secret" },
  github: { clientId: "github-client-id", clientSecret: "github-secret" },
};

export const AUDIT_TOKEN = "test-audit-token-gateway-0123456789abcdef";
export const SESSION_SECRET = "test-session-secret-0123456789abcdef0123";
export const DASHBOARD_ORIGIN = "https://dashboard.test";

export async function startGateway(
  overrides: Partial<Omit<GatewayAppOptions, "rateLimits" | "audit">> & {
    db: Database;
    rateLimits?: Partial<RateLimitSettings>;
    audit?: FakeAudit;
  },
): Promise<FastifyInstance> {
  const { rateLimits, audit = new FakeAudit(), ...rest } = overrides;
  const app = buildApp({
    audit: audit.client,
    auditUrl: "http://127.0.0.1:1",
    identityUrl: "http://127.0.0.1:1",
    flagsUrl: "http://127.0.0.1:1",
    auditToken: AUDIT_TOKEN,
    adminApiEnabled: true,
    dashboard: {
      origin: DASHBOARD_ORIGIN,
      session: {
        secret: SESSION_SECRET,
        accessTtlMs: 15 * 60_000,
        refreshTtlMs: 30 * 24 * 60 * 60_000,
        refreshGraceMs: 30_000,
        cookieSecure: true,
      },
      authLimits: { perIp: 1_000, perEmail: 1_000 },
      oauth: TEST_OAUTH,
    },
    rateLimitStore: new MemoryRateLimitStore(),
    adminToken: ADMIN_TOKEN,
    apiKeyHashSecret: API_KEY_HASH_SECRET,
    apiKeyPrefix: "sk_test_",
    storageUrl: "http://127.0.0.1:1",
    secretsUrl: "http://127.0.0.1:1",
    connectTimeoutMs: 1_000,
    responseTimeoutMs: 1_000,
    maxUploadBytes: 1024 * 1024,
    maxSecretBytes: 1024,
    server: TEST_SERVER_LIMITS,
    trustProxy: false,
    proxy: { allowedHosts: [], allowPrivateTargets: false },
    ...rest,
    rateLimits: { ...TEST_RATE_LIMITS, ...rateLimits },
  });
  cleanups.push(() => app.close());
  await app.ready();
  return app;
}

export interface ErrorBody {
  error: { code: string; message: string; requestId: string };
}

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const adminHeaders = { authorization: `Bearer ${ADMIN_TOKEN}` };

export async function createTenantWithKey(
  app: FastifyInstance,
  name = "Acme",
): Promise<{ tenantId: string; keyId: string; key: string }> {
  const tenant = await app.inject({
    method: "POST",
    url: "/admin/tenants",
    headers: adminHeaders,
    payload: { name },
  });
  const tenantId = tenant.json<{ id: string }>().id;
  const created = await app.inject({
    method: "POST",
    url: `/admin/tenants/${tenantId}/api-keys`,
    headers: adminHeaders,
    payload: { name: `${name} key` },
  });
  const { id: keyId, key } = created.json<{ id: string; key: string }>();
  return { tenantId, keyId, key };
}

export function expectError(
  response: LightMyRequestResponse,
  statusCode: number,
  code: string,
  message?: string,
): void {
  expect(response.statusCode).toBe(statusCode);
  const body = response.json<ErrorBody>();
  expect(Object.keys(body)).toEqual(["error"]);
  expect(body.error.code).toBe(code);
  if (message !== undefined) expect(body.error.message).toBe(message);
  expect(body.error.requestId).toMatch(UUID_PATTERN);
  expect(body.error.requestId).toBe(response.headers["x-request-id"]);
}

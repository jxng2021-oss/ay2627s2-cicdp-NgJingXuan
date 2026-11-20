import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, afterEach } from "vitest";
import type { ServiceName } from "../../services/audit/src/actions.js";
import { buildApp } from "../../services/audit/src/app.js";
import {
  MIGRATIONS_FOLDER,
  type Database,
} from "../../services/audit/src/db/client.js";
import * as schema from "../../services/audit/src/db/schema.js";

export const HMAC_KEY = "test-audit-hmac-key-0123456789abcdef0123";
export const TOKENS: Record<ServiceName, string> = {
  gateway: "test-audit-token-gateway-0123456789abcdef",
  secrets: "test-audit-token-secrets-0123456789abcdef",
  storage: "test-audit-token-storage-0123456789abcdef",
  identity: "test-audit-token-identity-0123456789abcdef",
  flags: "test-audit-token-flags-0123456789abcdef0",
};

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
    await shared.client.exec("truncate table audit_events");
  }
  return shared;
}

export async function startAudit(
  options: { db?: Database; logStream?: Writable } = {},
): Promise<FastifyInstance> {
  const db = options.db ?? (await createTestDatabase()).db;
  const app = buildApp({
    db,
    hmacKey: HMAC_KEY,
    serviceTokens: TOKENS,
    logger: options.logStream
      ? { level: "info", stream: options.logStream }
      : false,
  });
  cleanups.push(() => app.close());
  await app.ready();
  return app;
}

export function sendEvent(
  app: FastifyInstance,
  service: string,
  event: Record<string, unknown>,
  token: string | null = TOKENS[service as ServiceName] ?? null,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url: "/internal/events",
    headers: {
      "x-audit-service": service,
      "x-request-id": randomUUID(),
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    payload: event,
  });
}

export function readEvents(
  app: FastifyInstance,
  tenantId: string,
  query = "",
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "GET",
    url: `/events${query}`,
    headers: {
      "x-audit-service": "gateway",
      authorization: `Bearer ${TOKENS.gateway}`,
      "x-tenant-id": tenantId,
    },
  });
}

export const secretRead = (tenantId: string, name = "db-password") => ({
  action: "secret.read",
  outcome: "success",
  actorType: "api_key",
  actorId: randomUUID(),
  tenantId,
  resourceId: name,
  requestId: randomUUID(),
  sourceIp: "203.0.113.7",
});

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

import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, afterEach } from "vitest";
import { buildApp } from "../../services/secrets/src/app.js";
import {
  AuditClient,
  type AuditEvent,
} from "../../services/secrets/src/audit.js";
import type { KeyProvider } from "../../services/secrets/src/crypto/key-provider.js";
import {
  MIGRATIONS_FOLDER,
  type Database,
} from "../../services/secrets/src/db/client.js";
import * as schema from "../../services/secrets/src/db/schema.js";
import { SecretService } from "../../services/secrets/src/services/secret.service.js";

export { testKeyProvider } from "./test-key-provider.js";
import { testKeyProvider } from "./test-key-provider.js";

export const MAX_SECRET_BYTES = 1024;
export const INTERNAL_SERVICE_TOKEN =
  "test-internal-service-token-0123456789abcdef";
export const IDENTITY_SERVICE_TOKEN =
  "test-identity-service-token-0123456789abcdef";

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
      "truncate table secret_versions, secrets, tenant_keys, seal_config cascade",
    );
  }
  return shared;
}

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

export async function startSecrets(
  options: {
    db?: Database;
    keyProvider?: KeyProvider;
    logStream?: Writable;
    audit?: FakeAudit;
  } = {},
): Promise<FastifyInstance> {
  const db = options.db ?? (await createTestDatabase()).db;
  const audit = options.audit ?? new FakeAudit();
  const app = buildApp({
    db,
    keyProvider: options.keyProvider ?? testKeyProvider(),
    maxSecretBytes: MAX_SECRET_BYTES,
    internalServiceToken: INTERNAL_SERVICE_TOKEN,
    identityServiceToken: IDENTITY_SERVICE_TOKEN,
    audit: audit.client,
    logger: options.logStream
      ? { level: "info", stream: options.logStream }
      : false,
  });
  cleanups.push(() => app.close());
  await app.ready();
  return app;
}

export function call(
  app: FastifyInstance,
  tenantId: string,
  method: "GET" | "PUT" | "POST" | "DELETE",
  url: string,
  value?: string,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    headers: { "x-tenant-id": tenantId, "x-request-id": randomUUID() },
    ...(value === undefined ? {} : { payload: { value } }),
  });
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

export const newTenant = () => randomUUID();

export async function injectedValue(
  app: FastifyInstance,
  tenantId: string,
  name: string,
): Promise<{ status: number; value?: string; body: string }> {
  const response = await app.inject({
    method: "GET",
    url: `/internal/secrets/${name}`,
    headers: { "x-tenant-id": tenantId, "x-request-id": randomUUID() },
  });
  const value =
    response.statusCode === 200
      ? response.json<{ value: string }>().value
      : undefined;
  return { status: response.statusCode, value, body: response.body };
}

export async function storedValue(
  db: Database,
  tenantId: string,
  name: string,
  version?: number,
  keyProvider: KeyProvider = testKeyProvider(),
): Promise<string | undefined> {
  return (
    await new SecretService(db, keyProvider).read(tenantId, name, version)
  )?.value;
}

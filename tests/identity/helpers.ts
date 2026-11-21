import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { Writable } from "node:stream";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, afterEach } from "vitest";
import { buildApp } from "../../services/identity/src/app.js";
import {
  AuditClient,
  type AuditEvent,
} from "../../services/identity/src/audit.js";
import {
  MIGRATIONS_FOLDER,
  type Database,
} from "../../services/identity/src/db/client.js";
import * as schema from "../../services/identity/src/db/schema.js";
import {
  SealedError,
  type KeyVault,
} from "../../services/identity/src/services/key-vault.service.js";

export const PUBLIC_BASE_URL = "https://api.example.test";
export const PASSWORD = `test-${randomUUID()}`;

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
      "truncate table used_refresh_tokens, pool_sessions, pool_users, signing_keys, pools cascade",
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

export class FakeVault implements KeyVault {
  sealed = false;
  calls = 0;
  private readonly key = randomBytes(32);

  wrap(tenantId: string, poolId: string, dataKey: Buffer): Promise<Buffer> {
    this.calls++;
    if (this.sealed) return Promise.reject(new SealedError());
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(`${tenantId}/${poolId}`));
    const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    return Promise.resolve(
      Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]),
    );
  }

  unwrap(tenantId: string, poolId: string, wrapped: Buffer): Promise<Buffer> {
    this.calls++;
    if (this.sealed) return Promise.reject(new SealedError());
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      wrapped.subarray(0, 12),
    );
    decipher.setAAD(Buffer.from(`${tenantId}/${poolId}`));
    decipher.setAuthTag(wrapped.subarray(12, 28));
    return Promise.resolve(
      Buffer.concat([decipher.update(wrapped.subarray(28)), decipher.final()]),
    );
  }
}

export interface TestService {
  app: FastifyInstance;
  db: Database;
  audit: FakeAudit;
  vault: FakeVault;
  clock: { now: number };
}

export async function startIdentity(
  options: { logStream?: Writable } = {},
): Promise<TestService> {
  const { db } = await createTestDatabase();
  const audit = new FakeAudit();
  const vault = new FakeVault();
  const clock = { now: Date.now() };
  const app = buildApp({
    db,
    keyVault: vault,
    audit: audit.client,
    publicBaseUrl: PUBLIC_BASE_URL,
    now: () => clock.now,
    logger: options.logStream
      ? { level: "info", stream: options.logStream }
      : false,
  });
  cleanups.push(() => app.close());
  await app.ready();
  return { app, db, audit, vault, clock };
}

export function call(
  app: FastifyInstance,
  tenantId: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    headers: {
      "x-tenant-id": tenantId,
      "x-request-id": randomUUID(),
      "x-actor-id": randomUUID(),
      "x-client-ip": "203.0.113.7",
    },
    ...(body === undefined ? {} : { payload: body as object }),
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

export async function createPool(
  app: FastifyInstance,
  tenantId: string,
  body: Record<string, unknown> = { name: "Customers" },
): Promise<string> {
  const response = await call(app, tenantId, "POST", "/pools", body);
  if (response.statusCode !== 201) {
    throw new Error(`pool not created: ${response.body}`);
  }
  return response.json<{ id: string }>().id;
}

export async function signUp(
  app: FastifyInstance,
  tenantId: string,
  poolId: string,
  email: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const response = await call(app, tenantId, "POST", `/pools/${poolId}/users`, {
    email,
    password: PASSWORD,
    ...extra,
  });
  if (response.statusCode !== 201) {
    throw new Error(`user not created: ${response.body}`);
  }
  return response.json<{ id: string }>().id;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
  user: { id: string; email: string };
}

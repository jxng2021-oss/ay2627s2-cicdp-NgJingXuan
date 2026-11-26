import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../services/identity/src/app.js";
import {
  AuditClient,
  AuditUnavailableError,
  httpAuditTransport,
} from "../../services/identity/src/audit.js";
import { loadConfig } from "../../services/identity/src/config.js";
import {
  connectDatabase,
  type Database,
} from "../../services/identity/src/db/client.js";
import {
  MAX_PASSWORD_LENGTH,
  passwordProblem,
  verifyPassword,
} from "../../services/identity/src/passwords.js";
import {
  SealedError,
  SecretsKeyVault,
} from "../../services/identity/src/services/key-vault.service.js";
import {
  KEY_FORMAT_VERSION,
  newSigningKey,
  openSigningKey,
} from "../../services/identity/src/signing.js";
import {
  call,
  FakeAudit,
  FakeVault,
  newTenant,
  PUBLIC_BASE_URL,
  startIdentity,
} from "./helpers.js";

const TOKEN = "test-identity-token-0123456789abcdef0123";
const AUDIT = "test-identity-audit-0123456789abcdef0123";

const validEnv = (): NodeJS.ProcessEnv => ({
  DATABASE_URL: "postgres://identity_app:pw@postgres:5432/identity",
  IDENTITY_SERVICE_TOKEN: TOKEN,
  AUDIT_TOKEN: AUDIT,
});

describe("identity settings", () => {
  it("loads valid settings with safe defaults", () => {
    expect(loadConfig(validEnv())).toEqual({
      host: "0.0.0.0",
      port: 3004,
      databaseUrl: "postgres://identity_app:pw@postgres:5432/identity",
      secretsUrl: "http://localhost:3002",
      identityServiceToken: TOKEN,
      auditUrl: "http://localhost:3003",
      auditToken: AUDIT,
      auditTimeoutMs: 2_000,
      publicBaseUrl: "http://localhost:8080",
      version: "dev",
      requestTimeoutMs: 30_000,
      shutdownTimeoutMs: 25_000,
    });
  });

  it("uses the values it is given and trims the public URL", () => {
    expect(
      loadConfig({
        ...validEnv(),
        HOST: "127.0.0.1",
        IDENTITY_PORT: "4004",
        SECRETS_URL: "http://secrets:3002",
        AUDIT_URL: "http://audit:3003",
        PUBLIC_BASE_URL: "https://api.example.com/",
        SERVICE_VERSION: "1.2.3",
        REQUEST_TIMEOUT_MS: "",
      }),
    ).toMatchObject({
      host: "127.0.0.1",
      port: 4004,
      secretsUrl: "http://secrets:3002",
      auditUrl: "http://audit:3003",
      publicBaseUrl: "https://api.example.com",
      version: "1.2.3",
      requestTimeoutMs: 30_000,
    });
  });

  it("refuses missing, short or malformed settings", () => {
    const env = validEnv();
    delete env.DATABASE_URL;
    expect(() => loadConfig(env)).toThrow("DATABASE_URL must be set");
    expect(() =>
      loadConfig({ ...validEnv(), IDENTITY_SERVICE_TOKEN: "short" }),
    ).toThrow("IDENTITY_SERVICE_TOKEN must be set, at least 32 characters");
    const noAudit = validEnv();
    delete noAudit.AUDIT_TOKEN;
    expect(() => loadConfig(noAudit)).toThrow(
      "AUDIT_TOKEN must be set, at least 32 characters",
    );
    expect(() =>
      loadConfig({ ...validEnv(), PUBLIC_BASE_URL: "https://a.example/path" }),
    ).toThrow("PUBLIC_BASE_URL must be an origin");
    for (const value of ["0", "-5", "2.5", "x"]) {
      expect(() =>
        loadConfig({ ...validEnv(), SHUTDOWN_TIMEOUT_MS: value }),
      ).toThrow("SHUTDOWN_TIMEOUT_MS must be a positive whole number");
    }
  });

  it("creates a database pool without connecting until it is used", async () => {
    const { db, close } = connectDatabase(
      "postgres://identity_app:pw@127.0.0.1:1/identity",
    );
    expect(db).toBeDefined();
    await close();
  });
});

describe("passwords and signing keys", () => {
  it("refuses a password over the maximum length", () => {
    expect(passwordProblem("a".repeat(MAX_PASSWORD_LENGTH + 1), 12)).toBe(
      `The password must be at most ${MAX_PASSWORD_LENGTH} characters`,
    );
  });

  it("treats a broken stored hash as a wrong password", async () => {
    expect(await verifyPassword("not-a-hash", "whatever-password")).toBe(false);
  });

  it("refuses a signing key in an unknown format or with a bad tag", () => {
    const tenant = randomUUID();
    const pool = randomUUID();
    const key = newSigningKey(tenant, pool);
    expect(() =>
      openSigningKey(
        tenant,
        pool,
        key.kid,
        { ...key.encrypted, formatVersion: KEY_FORMAT_VERSION + 1 },
        key.dataKey,
      ),
    ).toThrow("unknown signing key format");
    expect(() =>
      openSigningKey(
        tenant,
        pool,
        key.kid,
        { ...key.encrypted, authTag: key.encrypted.authTag.subarray(0, 8) },
        key.dataKey,
      ),
    ).toThrow("authentication tag is the wrong length");
  });
});

const fakeLog = () => {
  const log = { error: vi.fn(), warn: vi.fn() };
  return { log, logger: log as unknown as FastifyBaseLogger };
};

describe("the audit client", () => {
  it("refuses the action when a strict event cannot be saved", async () => {
    const { log, logger } = fakeLog();
    const client = new AuditClient(() => Promise.reject(new Error("down")));
    await expect(
      client.record(
        { action: "user_pool.created", outcome: "success", actorType: "user" },
        logger,
      ),
    ).rejects.toBeInstanceOf(AuditUnavailableError);
    expect(log.error).toHaveBeenCalledOnce();
  });

  it("retries a best effort event and warns if it is lost", async () => {
    const { log, logger } = fakeLog();
    const transport = vi.fn(() => Promise.reject(new Error("down")));
    await new AuditClient(transport, [1]).recordBestEffort(
      {
        action: "pool_user.logged_in",
        outcome: "success",
        actorType: "api_key",
      },
      logger,
    );
    expect(transport).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledOnce();
  });
});

interface Received {
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

let server: Server | undefined;
afterEach(async () => {
  await new Promise((resolve) => server?.close(resolve) ?? resolve(undefined));
  server = undefined;
});

async function fakeService(answer: (path: string) => [number, string]) {
  const received: Received[] = [];
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      received.push({ url: request.url ?? "", headers: request.headers, body });
      const [status, text] = answer(request.url ?? "");
      response.statusCode = status;
      response.end(text);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/`, received };
}

describe("sending events to the audit service", () => {
  it("posts with the service name and token, and fails on anything but 201", async () => {
    let status = 201;
    const audit = await fakeService(() => [status, "{}"]);
    const { transport, close } = httpAuditTransport({
      url: audit.url,
      service: "identity",
      token: AUDIT,
      timeoutMs: 2_000,
    });
    const event = {
      action: "user_pool.created",
      outcome: "success" as const,
      actorType: "user" as const,
    };
    await transport({ ...event, requestId: randomUUID() });
    await transport(event);
    expect(audit.received[0]!.headers).toMatchObject({
      "x-audit-service": "identity",
      authorization: `Bearer ${AUDIT}`,
    });
    expect(audit.received[1]!.headers["x-request-id"]).toBeUndefined();
    status = 500;
    await expect(transport(event)).rejects.toThrow(
      "the audit service answered 500",
    );
    await close();
  });
});

describe("the secrets service key vault", () => {
  it("wraps and unwraps signing data keys", async () => {
    const secrets = await fakeService((path) =>
      path.endsWith("/wrap")
        ? [
            200,
            JSON.stringify({
              wrappedKey: Buffer.from("wrapped").toString("base64"),
            }),
          ]
        : [
            200,
            JSON.stringify({ key: Buffer.from("plain").toString("base64") }),
          ],
    );
    const vault = new SecretsKeyVault(secrets.url, TOKEN, 2_000);
    const tenant = randomUUID();
    const pool = randomUUID();
    const wrapped = await vault.wrap(tenant, pool, randomBytes(32), "req-1");
    expect(wrapped.toString()).toBe("wrapped");
    const plain = await vault.unwrap(tenant, pool, wrapped, "req-2");
    expect(plain.toString()).toBe("plain");
    expect(secrets.received[0]).toMatchObject({
      url: "/internal/signing-keys/wrap",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "x-tenant-id": tenant,
        "x-request-id": "req-1",
      },
    });
    expect(JSON.parse(secrets.received[0]!.body)).toMatchObject({
      poolId: pool,
    });
    await vault.close();
  });

  it("reports a sealed vault and other failures", async () => {
    let answer: [number, string] = [
      503,
      JSON.stringify({ error: { code: "SECRETS_SEALED" } }),
    ];
    const secrets = await fakeService(() => answer);
    const vault = new SecretsKeyVault(secrets.url, TOKEN, 2_000);
    await expect(
      vault.wrap(randomUUID(), randomUUID(), randomBytes(32), "r"),
    ).rejects.toBeInstanceOf(SealedError);
    answer = [500, "not json"];
    await expect(
      vault.unwrap(randomUUID(), randomUUID(), randomBytes(8), "r"),
    ).rejects.toThrow("the secrets service answered 500 to unwrap");
    await vault.close();
  });
});

describe("identity requests", () => {
  it("refuses outside traffic and a missing tenant", async () => {
    const { app } = await startIdentity();
    const outside = await app.inject({
      method: "GET",
      url: "/pools",
      remoteAddress: "8.8.8.8",
    });
    expect(outside.statusCode).toBe(403);
    const noTenant = await app.inject({ method: "GET", url: "/pools" });
    expect(noTenant.statusCode).toBe(400);
  });

  it("answers unknown routes, bad bodies and big bodies in the standard format", async () => {
    const { app } = await startIdentity();
    const tenant = newTenant();
    const unknown = await call(app, tenant, "GET", "/nope");
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    const headers = { "x-tenant-id": tenant };
    const notJson = await app.inject({
      method: "POST",
      url: "/pools",
      headers: { ...headers, "content-type": "text/plain" },
      payload: "x",
    });
    expect(notJson.statusCode).toBe(415);
    const big = await app.inject({
      method: "POST",
      url: "/pools",
      headers: { ...headers, "content-type": "application/json" },
      payload: JSON.stringify({ name: "x".repeat(20_000) }),
    });
    expect(big.statusCode).toBe(413);
    const broken = await app.inject({
      method: "POST",
      url: "/pools",
      headers: { ...headers, "content-type": "application/json" },
      payload: "{broken",
    });
    expect(broken.statusCode).toBe(400);
  });

  it("answers an unexpected failure with a generic 500", async () => {
    const db = {
      execute: () => Promise.reject(new Error("database exploded")),
      select: () => {
        throw new Error("database exploded");
      },
      transaction: () => Promise.reject(new Error("database exploded")),
    } as unknown as Database;
    const app = buildApp({
      db,
      keyVault: new FakeVault(),
      audit: new FakeAudit().client,
      publicBaseUrl: PUBLIC_BASE_URL,
    });
    await app.ready();
    const response = await call(app, newTenant(), "GET", "/pools");
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      error: { code: "INTERNAL_ERROR" },
    });
    expect(response.body).not.toContain("exploded");
    const ready = await app.inject({ method: "GET", url: "/ready" });
    expect(ready.statusCode).toBe(503);
    await app.close();
  });

  it("refuses new requests while shutting down", async () => {
    const { app } = await startIdentity();
    const closing = app.close();
    const answer = app
      .inject({ method: "GET", url: "/health" })
      .catch(() => ({ statusCode: 0 }));
    await closing;
    expect([0, 503]).toContain((await answer).statusCode);
  });
});

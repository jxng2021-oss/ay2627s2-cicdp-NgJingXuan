import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../services/flags/src/app.js";
import {
  AuditClient,
  AuditUnavailableError,
  httpAuditTransport,
} from "../../services/flags/src/audit.js";
import { loadConfig } from "../../services/flags/src/config.js";
import {
  connectDatabase,
  type Database,
} from "../../services/flags/src/db/client.js";
import { call, FakeAudit, newTenant, startFlags } from "./helpers.js";

const TOKEN = "test-flags-audit-token-0123456789abcdef";

const validEnv = (): NodeJS.ProcessEnv => ({
  DATABASE_URL: "postgres://flags_app:pw@postgres:5432/flags",
  AUDIT_TOKEN: TOKEN,
});

describe("flags settings", () => {
  it("loads valid settings with safe defaults", () => {
    expect(loadConfig(validEnv())).toEqual({
      host: "0.0.0.0",
      port: 3005,
      databaseUrl: "postgres://flags_app:pw@postgres:5432/flags",
      auditUrl: "http://localhost:3003",
      auditToken: TOKEN,
      auditTimeoutMs: 2_000,
      version: "dev",
      shutdownTimeoutMs: 25_000,
    });
  });

  it("uses the values it is given", () => {
    const config = loadConfig({
      ...validEnv(),
      HOST: "127.0.0.1",
      FLAGS_PORT: "4005",
      AUDIT_URL: "http://audit:3003",
      AUDIT_TIMEOUT_MS: "500",
      SERVICE_VERSION: "1.2.3",
      SHUTDOWN_TIMEOUT_MS: "",
    });
    expect(config).toMatchObject({
      host: "127.0.0.1",
      port: 4005,
      auditUrl: "http://audit:3003",
      auditTimeoutMs: 500,
      version: "1.2.3",
      shutdownTimeoutMs: 25_000,
    });
  });

  it("refuses a missing database URL or a short audit token", () => {
    const env = validEnv();
    delete env.DATABASE_URL;
    expect(() => loadConfig(env)).toThrow("DATABASE_URL must be set");
    expect(() => loadConfig({ ...validEnv(), AUDIT_TOKEN: "short" })).toThrow(
      "AUDIT_TOKEN must be set, at least 32 characters",
    );
  });

  it("refuses numbers that are not positive whole numbers", () => {
    for (const value of ["0", "-1", "1.5", "abc"]) {
      expect(() => loadConfig({ ...validEnv(), FLAGS_PORT: value })).toThrow(
        "FLAGS_PORT must be a positive whole number",
      );
    }
  });

  it("creates a database pool without connecting until it is used", async () => {
    const { db, close } = connectDatabase(
      "postgres://flags_app:pw@127.0.0.1:1/flags",
    );
    expect(db).toBeDefined();
    await close();
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
        { action: "flag.created", outcome: "success", actorType: "user" },
        logger,
      ),
    ).rejects.toBeInstanceOf(AuditUnavailableError);
    expect(log.error).toHaveBeenCalledOnce();
  });

  it("retries a best effort event, then warns once and carries on", async () => {
    const { log, logger } = fakeLog();
    const transport = vi.fn(() => Promise.reject(new Error("down")));
    const client = new AuditClient(transport, [1, 1]);
    await client.recordBestEffort(
      { action: "flag.created", outcome: "success", actorType: "user" },
      logger,
    );
    expect(transport).toHaveBeenCalledTimes(3);
    expect(log.warn).toHaveBeenCalledOnce();
  });
});

interface Received {
  headers: IncomingMessage["headers"];
  body: string;
}

let server: Server | undefined;
afterEach(async () => {
  await new Promise((resolve) => server?.close(resolve) ?? resolve(undefined));
  server = undefined;
});

async function fakeAuditService(status: number) {
  const received: Received[] = [];
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      received.push({ headers: request.headers, body });
      response.statusCode = status;
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/`, received };
}

describe("sending events to the audit service", () => {
  it("posts the event with the service name, token and request ID", async () => {
    const audit = await fakeAuditService(201);
    const { transport, close } = httpAuditTransport({
      url: audit.url,
      service: "flags",
      token: TOKEN,
      timeoutMs: 2_000,
    });
    await transport({
      action: "flag.created",
      outcome: "success",
      actorType: "user",
      requestId: "3c7d2f0e-1f7a-4c55-9b2c-0d1e2f3a4b5c",
    });
    await transport({
      action: "flag.deleted",
      outcome: "success",
      actorType: "user",
    });
    await close();
    expect(audit.received).toHaveLength(2);
    expect(audit.received[0]!.headers).toMatchObject({
      "x-audit-service": "flags",
      authorization: `Bearer ${TOKEN}`,
      "x-request-id": "3c7d2f0e-1f7a-4c55-9b2c-0d1e2f3a4b5c",
    });
    expect(audit.received[1]!.headers["x-request-id"]).toBeUndefined();
    expect(JSON.parse(audit.received[0]!.body)).toMatchObject({
      action: "flag.created",
    });
  });

  it("fails when the audit service does not answer 201", async () => {
    const audit = await fakeAuditService(503);
    const { transport, close } = httpAuditTransport({
      url: audit.url,
      service: "flags",
      token: TOKEN,
      timeoutMs: 2_000,
    });
    await expect(
      transport({
        action: "flag.created",
        outcome: "success",
        actorType: "user",
      }),
    ).rejects.toThrow("the audit service answered 503");
    await close();
  });
});

describe("flags requests", () => {
  it("refuses traffic from outside the internal network", async () => {
    const { app } = await startFlags();
    const response = await app.inject({
      method: "GET",
      url: "/flags",
      remoteAddress: "8.8.8.8",
      headers: { "x-tenant-id": newTenant() },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  it("needs a valid tenant header", async () => {
    const { app } = await startFlags();
    const response = await app.inject({ method: "GET", url: "/flags" });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { message: "A valid X-Tenant-Id header is required" },
    });
  });

  it("answers an unknown route with the standard 404", async () => {
    const { app } = await startFlags();
    const response = await call(app, newTenant(), "GET", "/nope");
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("refuses bodies that are not JSON or too large", async () => {
    const { app } = await startFlags();
    const headers = { "x-tenant-id": newTenant() };
    const notJson = await app.inject({
      method: "POST",
      url: "/flags",
      headers: { ...headers, "content-type": "text/plain" },
      payload: "hello",
    });
    expect(notJson.statusCode).toBe(415);
    const tooLarge = await app.inject({
      method: "POST",
      url: "/flags",
      headers: { ...headers, "content-type": "application/json" },
      payload: JSON.stringify({ padding: "x".repeat(2_000_000) }),
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json()).toMatchObject({
      error: { code: "PAYLOAD_TOO_LARGE" },
    });
  });

  it("refuses a change with 503 when the audit log is down", async () => {
    const { app, audit } = await startFlags();
    audit.down = true;
    const response = await call(app, newTenant(), "POST", "/flags", {
      key: "new-checkout",
      kind: "boolean",
      offValue: false,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "SERVICE_UNAVAILABLE" },
    });
  });

  it("keeps a valid client IP and user actor from the gateway", async () => {
    const { app, audit } = await startFlags();
    const response = await app.inject({
      method: "POST",
      url: "/flags",
      headers: {
        "x-tenant-id": newTenant(),
        "x-actor-id": "3c7d2f0e-1f7a-4c55-9b2c-0d1e2f3a4b5c",
        "x-actor-type": "user",
        "x-client-ip": "203.0.113.9",
      },
      payload: { key: "new-checkout", kind: "boolean", offValue: false },
    });
    expect(response.statusCode).toBe(201);
    expect(audit.events.at(-1)).toMatchObject({
      actorType: "user",
      sourceIp: "203.0.113.9",
    });
  });

  it("reports not ready when Postgres cannot be reached", async () => {
    const db = {
      execute: () => Promise.reject(new Error("connection refused")),
    } as unknown as Database;
    const app = buildApp({ db, audit: new FakeAudit().client });
    await app.ready();
    const ready = await app.inject({ method: "GET", url: "/ready" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({
      status: "not_ready",
      checks: { postgres: "down" },
    });
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    await app.close();
  });
});

describe("more flags behaviour", () => {
  it("records a best effort event once the audit service recovers", async () => {
    const { log, logger } = fakeLog();
    let failures = 1;
    const transport = vi.fn(() =>
      failures-- > 0 ? Promise.reject(new Error("down")) : Promise.resolve(),
    );
    await new AuditClient(transport, [1]).recordBestEffort(
      { action: "flag.created", outcome: "success", actorType: "user" },
      logger,
    );
    expect(transport).toHaveBeenCalledTimes(2);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("changes a flag's description", async () => {
    const { app, audit } = await startFlags();
    const tenant = newTenant();
    await call(app, tenant, "POST", "/flags", {
      key: "new-checkout",
      kind: "boolean",
      offValue: false,
    });
    const response = await call(app, tenant, "PATCH", "/flags/new-checkout", {
      description: "The new checkout",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ description: "The new checkout" });
    expect(audit.events.at(-1)).toMatchObject({
      action: "feature_flag.updated",
    });
    const missing = await call(app, tenant, "PATCH", "/flags/nope", {
      description: "x",
    });
    expect(missing.statusCode).toBe(404);
  });

  it("logs with the service name when logging is on", async () => {
    const lines: string[] = [];
    const app = buildApp({
      db: (await startFlags()).db,
      audit: new FakeAudit().client,
      version: "1.2.3",
      logger: {
        level: "info",
        stream: { write: (line: string) => lines.push(line) },
      },
    });
    await app.ready();
    await app.inject({ method: "GET", url: "/health" });
    await app.close();
    expect(lines.join("")).toContain('"service":"flags"');
    expect(lines.join("")).toContain('"version":"1.2.3"');
  });

  it("answers an unexpected failure with a generic 500", async () => {
    const db = {
      execute: () => Promise.resolve(),
      select: () => {
        throw new Error("database exploded");
      },
      transaction: () => Promise.reject(new Error("database exploded")),
    } as unknown as Database;
    const app = buildApp({ db, audit: new FakeAudit().client });
    await app.ready();
    const response = await call(app, newTenant(), "GET", "/flags");
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      error: { code: "INTERNAL_ERROR", message: "Something went wrong" },
    });
    expect(response.body).not.toContain("exploded");
    await app.close();
  });

  it("refuses new requests while shutting down", async () => {
    const { app } = await startFlags();
    const closing = app.close();
    const answer = app.inject({ method: "GET", url: "/health" }).catch(() => ({
      statusCode: 0,
    }));
    await closing;
    expect([0, 503]).toContain((await answer).statusCode);
  });
});

import { describe, expect, it } from "vitest";
import { loadConfig } from "../../services/audit/src/config.js";
import { connectDatabase } from "../../services/audit/src/db/client.js";
import { HMAC_KEY, readEvents, startAudit, TOKENS } from "./helpers.js";

const validEnv = (): NodeJS.ProcessEnv => ({
  DATABASE_URL: "postgres://audit_app:pw@postgres:5432/audit",
  AUDIT_HMAC_KEY: HMAC_KEY,
  AUDIT_TOKEN_GATEWAY: TOKENS.gateway,
  AUDIT_TOKEN_SECRETS: TOKENS.secrets,
  AUDIT_TOKEN_STORAGE: TOKENS.storage,
  AUDIT_TOKEN_IDENTITY: TOKENS.identity,
  AUDIT_TOKEN_FLAGS: TOKENS.flags,
});

describe("audit settings", () => {
  it("loads valid settings with safe defaults", () => {
    const config = loadConfig(validEnv());
    expect(config).toMatchObject({
      host: "0.0.0.0",
      port: 3003,
      hmacKey: HMAC_KEY,
      version: "dev",
      shutdownTimeoutMs: 25_000,
      serviceTokens: TOKENS,
    });
  });

  it("uses the port, version and shutdown time it is given", () => {
    const config = loadConfig({
      ...validEnv(),
      HOST: "127.0.0.1",
      AUDIT_PORT: "4003",
      SERVICE_VERSION: "1.2.3",
      SHUTDOWN_TIMEOUT_MS: "1000",
    });
    expect(config).toMatchObject({
      host: "127.0.0.1",
      port: 4003,
      version: "1.2.3",
      shutdownTimeoutMs: 1000,
    });
  });

  it("refuses to start without a database URL", () => {
    const env = validEnv();
    delete env.DATABASE_URL;
    expect(() => loadConfig(env)).toThrow("DATABASE_URL must be set");
  });

  it("refuses a short or missing HMAC key or service token", () => {
    expect(() =>
      loadConfig({ ...validEnv(), AUDIT_HMAC_KEY: "short" }),
    ).toThrow("AUDIT_HMAC_KEY must be set, at least 32 characters");
    const env = validEnv();
    delete env.AUDIT_TOKEN_FLAGS;
    expect(() => loadConfig(env)).toThrow(
      "AUDIT_TOKEN_FLAGS must be set, at least 32 characters",
    );
  });

  it("refuses two services sharing one token", () => {
    expect(() =>
      loadConfig({ ...validEnv(), AUDIT_TOKEN_FLAGS: TOKENS.gateway }),
    ).toThrow("Each service needs its own audit token");
  });

  it("creates a database pool without connecting until it is used", async () => {
    const { db, close } = connectDatabase(
      "postgres://audit_app:pw@127.0.0.1:1/audit",
    );
    expect(db).toBeDefined();
    await close();
  });
});

describe("audit error answers", () => {
  it("answers an unknown route with the standard 404", async () => {
    const app = await startAudit();
    const response = await app.inject({
      method: "GET",
      url: "/nope",
      headers: {
        "x-audit-service": "gateway",
        authorization: `Bearer ${TOKENS.gateway}`,
      },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: "NOT_FOUND", message: "Not found" },
    });
  });

  it("refuses a body that is not JSON", async () => {
    const app = await startAudit();
    const response = await app.inject({
      method: "POST",
      url: "/internal/events",
      headers: {
        "content-type": "text/plain",
        "x-audit-service": "gateway",
        authorization: `Bearer ${TOKENS.gateway}`,
      },
      payload: "hello",
    });
    expect(response.statusCode).toBe(415);
    expect(response.json()).toMatchObject({
      error: { code: "UNSUPPORTED_MEDIA_TYPE" },
    });
  });

  it("refuses a body over the size limit", async () => {
    const app = await startAudit();
    const response = await app.inject({
      method: "POST",
      url: "/internal/events",
      headers: {
        "content-type": "application/json",
        "x-audit-service": "gateway",
        authorization: `Bearer ${TOKENS.gateway}`,
      },
      payload: JSON.stringify({ padding: "x".repeat(10_000) }),
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({
      error: { code: "PAYLOAD_TOO_LARGE" },
    });
  });

  it("answers broken JSON as a bad request", async () => {
    const app = await startAudit();
    const response = await app.inject({
      method: "POST",
      url: "/internal/events",
      headers: {
        "content-type": "application/json",
        "x-audit-service": "gateway",
        authorization: `Bearer ${TOKENS.gateway}`,
      },
      payload: "{not json",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "BAD_REQUEST" } });
  });
});

describe("more audit answers", () => {
  it("refuses dates that aren't timestamps", async () => {
    const app = await startAudit();
    const response = await readEvents(
      app,
      "3c7d2f0e-1f7a-4c55-9b2c-0d1e2f3a4b5c",
      "?from=not-a-date",
    );
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "BAD_REQUEST" } });
  });

  it("refuses new requests while shutting down", async () => {
    const app = await startAudit();
    const closing = app.close();
    const answer = app
      .inject({ method: "GET", url: "/health" })
      .catch(() => ({ statusCode: 0 }));
    await closing;
    expect([0, 503]).toContain((await answer).statusCode);
  });
});

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { AuditUnavailableError } from "../../services/secrets/src/audit.js";
import { buildOperatorApp } from "../../services/secrets/src/operator-app.js";
import {
  SealManager,
  type SealAudit,
} from "../../services/secrets/src/seal/seal-manager.js";
import {
  captureLogs,
  createTestDatabase,
  FakeAudit,
  newTenant,
  startSecrets,
} from "./helpers.js";

let audit: FakeAudit;
let app: FastifyInstance;
let tenant: string;
const keyId = randomUUID();
const requestId = randomUUID();

beforeEach(async () => {
  audit = new FakeAudit();
  app = await startSecrets({ audit });
  tenant = newTenant();
});

function call(
  method: "GET" | "PUT" | "POST" | "DELETE",
  url: string,
  value?: string,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method,
    url,
    headers: {
      "x-tenant-id": tenant,
      "x-request-id": requestId,
      "x-actor-id": keyId,
      "x-client-ip": "203.0.113.7",
      ...headers,
    },
    ...(value === undefined ? {} : { payload: { value } }),
  });
}

const expected = (action: string, name = "db-password") => ({
  action,
  outcome: "success",
  actorType: "api_key",
  actorId: keyId,
  tenantId: tenant,
  resourceId: name,
  requestId,
  sourceIp: "203.0.113.7",
});

describe("secret actions are recorded", () => {
  it("create, rotate (both ways), injection read and delete each make the right event", async () => {
    await call("PUT", "/secrets/db-password", "v1-value");
    await call("PUT", "/secrets/db-password", "v2-value");
    await call("POST", "/secrets/db-password/rotate", "v3-value");
    await call("GET", "/internal/secrets/db-password");
    await call("DELETE", "/secrets/db-password");

    expect(audit.events).toEqual([
      expected("secret.created"),
      expected("secret.rotated"),
      expected("secret.rotated"),
      expected("secret.read"),
      expected("secret.deleted"),
    ]);
  });

  it("records nothing for lists, metadata, version lists or missing secrets", async () => {
    await call("PUT", "/secrets/db-password", "v");
    audit.events = [];
    await call("GET", "/secrets");
    await call("GET", "/secrets/db-password");
    await call("GET", "/secrets/missing");
    await call("DELETE", "/secrets/missing");
    await call("POST", "/secrets/missing/rotate", "x");
    await call("GET", "/secrets/missing/versions");

    expect(audit.events).toEqual([]);
  });

  it("ignores malformed actor and IP headers instead of saving them", async () => {
    await call("PUT", "/secrets/db-password", "v", {
      "x-actor-id": "sk_live_not-an-id",
      "x-client-ip": "<script>",
    });

    expect(audit.events[0]).toMatchObject({ actorType: "service" });
    expect(audit.events[0]).not.toHaveProperty("actorId", expect.anything());
    expect(audit.events[0]?.sourceIp).toBeUndefined();
  });

  it("never puts a value in an event", async () => {
    await call("PUT", "/secrets/db-password", "super-secret-value-123");
    await call("GET", "/internal/secrets/db-password");

    expect(JSON.stringify(audit.events)).not.toContain("super-secret-value");
  });
});

describe("when the audit log is unavailable", () => {
  beforeEach(async () => {
    await call("PUT", "/secrets/db-password", "original-value");
    audit.down = true;
  });

  it("an injection read is refused with 503 and the value is not returned", async () => {
    const response = await call("GET", "/internal/secrets/db-password");

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "SERVICE_UNAVAILABLE" },
    });
    expect(response.body).not.toContain("original-value");
  });

  it("changes are refused with 503 and rolled back", async () => {
    const create = await call("PUT", "/secrets/new-one", "x");
    const put = await call("PUT", "/secrets/db-password", "changed");
    const rotate = await call("POST", "/secrets/db-password/rotate", "changed");
    const remove = await call("DELETE", "/secrets/db-password");

    expect([create, put, rotate, remove].map((r) => r.statusCode)).toEqual([
      503, 503, 503, 503,
    ]);
    audit.down = false;
    expect((await call("GET", "/secrets/new-one")).statusCode).toBe(404);
    expect((await call("GET", "/secrets/db-password")).json()).toMatchObject({
      version: 1,
    });
    const value = await call("GET", "/internal/secrets/db-password");
    expect(value.json()).toMatchObject({ value: "original-value" });
  });
});

describe("seal changes are recorded first", () => {
  async function manager(record: SealAudit) {
    const { db } = await createTestDatabase();
    const seal = new SealManager(
      db,
      {
        unsealTimeoutMs: 60_000,
        maxFailedAttempts: 5,
        lockoutMs: 60_000,
        drainTimeoutMs: 100,
      },
      Date.now,
      record,
    );
    await seal.load();
    return seal;
  }

  it("initialise, unseal and seal each make one platform event", async () => {
    const actions: string[] = [];
    const seal = await manager((action) => {
      actions.push(action);
      return Promise.resolve();
    });

    const { shares } = await seal.initialise();
    for (const share of shares.slice(0, 3)) await seal.submitShare(share);
    await seal.seal();
    await seal.seal();

    expect(actions).toEqual([
      "secrets.initialised",
      "secrets.unsealed",
      "secrets.sealed",
    ]);
  });

  it("without the audit log, nothing changes: not initialised, not unsealed, not sealed", async () => {
    let down = false;
    const seal = await manager(() =>
      down ? Promise.reject(new AuditUnavailableError()) : Promise.resolve(),
    );

    down = true;
    await expect(seal.initialise()).rejects.toThrow(AuditUnavailableError);
    expect(seal.state).toBe("uninitialised");

    down = false;
    const { shares } = await seal.initialise();
    down = true;
    for (const share of shares.slice(0, 2)) await seal.submitShare(share);
    await expect(seal.submitShare(shares[2]!)).rejects.toThrow(
      AuditUnavailableError,
    );
    expect(seal.state).toBe("sealed");

    down = false;
    for (const share of shares.slice(0, 3)) await seal.submitShare(share);
    down = true;
    await expect(seal.seal()).rejects.toThrow(AuditUnavailableError);
    expect(seal.state).toBe("unsealed");

    await seal.seal("shutdown");
    expect(seal.state).toBe("sealed");
  });

  it("the operator command answers 503 AUDIT_UNAVAILABLE", async () => {
    const seal = await manager(() =>
      Promise.reject(new AuditUnavailableError()),
    );
    const operator = buildOperatorApp(seal);

    const response = await operator.inject({ method: "POST", url: "/init" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "AUDIT_UNAVAILABLE" },
    });
    expect(response.body).not.toMatch(/shares/i);
    await operator.close();
  });
});

describe("logs", () => {
  it("one JSON line per request with service, version, request ID, route, status and duration; no values or tokens", async () => {
    const logs = captureLogs();
    audit = new FakeAudit();
    app = await startSecrets({ audit, logStream: logs.stream });

    await call("PUT", "/secrets/db-password", "logged-value-must-not-appear");
    await call("GET", "/secrets/db-password");

    const lines = logs
      .text()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.msg === "request completed");
    expect(lines[1]).toMatchObject({
      service: "secrets",
      version: "dev",
      requestId,
      route: "/secrets/:name",
      status: 200,
      method: "GET",
    });
    expect(typeof lines[1]?.durationMs).toBe("number");
    expect(logs.text()).not.toContain("logged-value-must-not-appear");
  });
});

describe("dashboard users", () => {
  it("a change by a dashboard user records the user as actor", async () => {
    await call("PUT", "/secrets/db-password", "v", { "x-actor-type": "user" });

    expect(audit.events).toEqual([
      { ...expected("secret.created"), actorType: "user", actorId: keyId },
    ]);
  });

  it("there is no reveal route: values are write-only", async () => {
    await call("PUT", "/secrets/db-password", "never-revealed");
    audit.events = [];

    const response = await call("POST", "/secrets/db-password/reveal");

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("never-revealed");
    expect(audit.events).toEqual([]);
  });

  it("an unknown actor type counts as an API key", async () => {
    await call("PUT", "/secrets/db-password", "v", { "x-actor-type": "admin" });

    expect(audit.events[0]?.actorType).toBe("api_key");
  });
});

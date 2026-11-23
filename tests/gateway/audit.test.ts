import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { ACTIONS } from "../../services/audit/src/actions.js";
import {
  POOL_AUDIT_ACTIONS,
  TENANT_AUDIT_ACTIONS,
} from "../../services/gateway/src/api/audit-schemas.js";
import { loadSpec } from "../../api/validate.js";
import {
  auditContract,
  expectPublicContract,
  secretsContract,
  serviceError,
  startContractService,
  startContractStorage,
  type ReceivedRequest,
  type ServiceReply,
} from "./contract-helpers.js";
import {
  adminHeaders,
  AUDIT_TOKEN,
  captureLogs,
  createTenantWithKey,
  createTestDatabase,
  expectError,
  FakeAudit,
  startGateway,
} from "./helpers.js";

let audit: FakeAudit;
let app: FastifyInstance;

beforeEach(async () => {
  audit = new FakeAudit();
  const { db } = await createTestDatabase();
  app = await startGateway({ db, audit });
});

const admin = (
  method: "POST" | "DELETE" | "GET",
  url: string,
  payload?: object,
) =>
  app.inject({ method, url: `/admin${url}`, headers: adminHeaders, payload });

describe("admin changes are recorded (strict)", () => {
  it("tenant created and suspended, API key created and revoked", async () => {
    const tenant = await admin("POST", "/tenants", { name: "Acme" });
    const tenantId = tenant.json<{ id: string }>().id;
    const key = await admin("POST", `/tenants/${tenantId}/api-keys`, {
      name: "k",
    });
    const keyId = key.json<{ id: string }>().id;
    const revoked = await admin(
      "DELETE",
      `/tenants/${tenantId}/api-keys/${keyId}`,
    );
    const suspended = await admin("POST", `/tenants/${tenantId}/suspend`);

    expect(suspended.json()).toMatchObject({ status: "suspended" });
    const event = (action: string, resourceId: string, requestId: unknown) => ({
      action,
      outcome: "success",
      actorType: "admin",
      tenantId,
      resourceId,
      requestId,
      sourceIp: "127.0.0.1",
    });
    expect(audit.events).toEqual([
      event("tenant.created", tenantId, tenant.headers["x-request-id"]),
      event("api_key.created", keyId, key.headers["x-request-id"]),
      event("api_key.revoked", keyId, revoked.headers["x-request-id"]),
      event("tenant.suspended", tenantId, suspended.headers["x-request-id"]),
    ]);
    const sent = JSON.stringify(audit.events);
    expect(sent).not.toContain(key.json<{ key: string }>().key);
    expect(sent).not.toContain(adminHeaders.authorization.slice(7));
  });

  it("records nothing for a missing tenant or key", async () => {
    await admin("POST", `/tenants/${randomUUID()}/suspend`);
    await admin("POST", `/tenants/${randomUUID()}/api-keys`, { name: "k" });
    await admin("DELETE", `/tenants/${randomUUID()}/api-keys/${randomUUID()}`);

    expect(audit.events).toEqual([]);
  });

  it("without the audit log, every change is refused with 503 and rolled back", async () => {
    const { tenantId, keyId, key } = await createTenantWithKey(app);
    audit.down = true;

    const responses = [
      await admin("POST", "/tenants", { name: "Not created" }),
      await admin("POST", `/tenants/${tenantId}/api-keys`, {
        name: "not created",
      }),
      await admin("DELETE", `/tenants/${tenantId}/api-keys/${keyId}`),
      await admin("POST", `/tenants/${tenantId}/suspend`),
    ];

    for (const response of responses) {
      expectError(response, 503, "SERVICE_UNAVAILABLE");
      expect(response.body).not.toMatch(/sk_test_/);
    }
    audit.down = false;
    const keys = await admin("GET", `/tenants/${tenantId}/api-keys`);
    expect(keys.json<{ apiKeys: { status: string }[] }>().apiKeys).toEqual([
      expect.objectContaining({ status: "active" }),
    ]);
    const used = await app.inject({
      method: "GET",
      url: "/v1/storage/files/not-an-id",
      headers: { authorization: `Bearer ${key}` },
    });
    expect(used.statusCode).toBe(400);
  });
});

describe("the internal services get the verified key ID and client IP", () => {
  it("sends X-Actor-Id and X-Client-Ip to storage, replacing any the client sent", async () => {
    const storage = await startContractStorage((req) =>
      serviceError(req, 404, "NOT_FOUND"),
    );
    const { db } = await createTestDatabase();
    app = await startGateway({ db, storageUrl: storage.url, audit });
    const { keyId, key } = await createTenantWithKey(app);

    await app.inject({
      method: "GET",
      url: `/v1/storage/files/${randomUUID()}`,
      headers: {
        authorization: `Bearer ${key}`,
        "x-actor-id": randomUUID(),
        "x-client-ip": "10.9.9.9",
      },
    });

    expect(storage.requests[0]?.headers).toMatchObject({
      "x-actor-id": keyId,
      "x-client-ip": "127.0.0.1",
    });
    expect(storage.problems).toEqual([]);
  });
});

describe("GET /v1/audit-events", () => {
  const EVENT = {
    id: randomUUID(),
    occurredAt: "2026-11-05T09:30:00.000Z",
    actorType: "api_key",
    actorId: randomUUID(),
    action: "secret.read",
    resourceType: "secret",
    resourceId: "db-password",
    outcome: "success",
    requestId: randomUUID(),
    sourceIp: "203.0.113.7",
  };

  async function withAudit(reply: (req: ReceivedRequest) => ServiceReply) {
    const service = await startContractService(
      auditContract,
      reply,
      `Bearer ${AUDIT_TOKEN}`,
    );
    const { db } = await createTestDatabase();
    app = await startGateway({ db, auditUrl: service.url, audit });
    return service;
  }

  it("reads only the caller's own tenant, with the gateway's token and validated filters", async () => {
    const service = await withAudit(() => ({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ events: [EVENT], nextCursor: null }),
    }));
    const { tenantId, key } = await createTenantWithKey(app);
    const url =
      "/v1/audit-events?action=secret.read&outcome=success&resourceType=secret&resourceId=db-password&from=2026-11-01T00:00:00Z&limit=10&cursor=42";

    const response = await app.inject({
      method: "GET",
      url,
      headers: {
        authorization: `Bearer ${key}`,
        "x-tenant-id": randomUUID(),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ events: [EVENT], nextCursor: null });
    expectPublicContract("GET", "/v1/audit-events", response);
    const sent = service.requests[0]!;
    expect(sent.headers).toMatchObject({
      "x-tenant-id": tenantId,
      "x-audit-service": "gateway",
      authorization: `Bearer ${AUDIT_TOKEN}`,
    });
    expect(
      Object.fromEntries(new URLSearchParams(sent.url.split("?")[1])),
    ).toEqual({
      from: "2026-11-01T00:00:00Z",
      action: "secret.read",
      outcome: "success",
      resourceType: "secret",
      resourceId: "db-password",
      limit: "10",
      cursor: "42",
    });
    expect(service.problems).toEqual([]);
  });

  it("refuses bad filters (400) and missing keys (401) without asking the audit service", async () => {
    const service = await withAudit(() => ({ status: 500 }));
    const { key } = await createTenantWithKey(app);

    for (const query of [
      "?action=secrets.sealed",
      "?action=nope",
      "?outcome=maybe",
      "?from=yesterday",
      "?limit=0",
      "?cursor=abc",
    ]) {
      const response = await app.inject({
        method: "GET",
        url: `/v1/audit-events${query}`,
        headers: { authorization: `Bearer ${key}` },
      });
      expectError(response, 400, "BAD_REQUEST");
      expectPublicContract("GET", "/v1/audit-events", response);
    }
    const anonymous = await app.inject({
      method: "GET",
      url: "/v1/audit-events",
    });
    expectError(anonymous, 401, "UNAUTHORIZED");
    expect(service.requests).toEqual([]);
  });

  it("passes the audit service being unavailable on as 503 or 502, within the contract", async () => {
    const service = await withAudit((req) =>
      serviceError(req, 503, "SERVICE_UNAVAILABLE"),
    );
    const { key } = await createTenantWithKey(app);
    const headers = { authorization: `Bearer ${key}` };

    const unavailable = await app.inject({
      method: "GET",
      url: "/v1/audit-events",
      headers,
    });
    const { db } = await createTestDatabase();
    app = await startGateway({
      db,
      auditUrl: "http://127.0.0.1:1",
      audit: new FakeAudit(),
    });
    const other = await createTenantWithKey(app);
    const down = await app.inject({
      method: "GET",
      url: "/v1/audit-events",
      headers: { authorization: `Bearer ${other.key}` },
    });

    expectError(unavailable, 503, "SERVICE_UNAVAILABLE");
    expectError(down, 502, "UPSTREAM_UNAVAILABLE");
    expectPublicContract("GET", "/v1/audit-events", unavailable);
    expectPublicContract("GET", "/v1/audit-events", down);
    expect(service.problems).toEqual([]);
  });

  it("lists exactly the tenant actions of the audit service", () => {
    const spec = loadSpec("api/internal/audit.openapi.json") as unknown as {
      components: {
        schemas: { NewEvent: { properties: { action: { enum: string[] } } } };
      };
    };
    const platformOnly = [
      "secrets.initialised",
      "secrets.unsealed",
      "secrets.sealed",
      "file.access_denied",
      "tenant.shredded",
      "user.oauth_linked",
    ];
    const tenantActions =
      spec.components.schemas.NewEvent.properties.action.enum.filter(
        (action) => !platformOnly.includes(action),
      );

    const addedWithPoolChains = ["pool_user.unlocked"];
    expect([...TENANT_AUDIT_ACTIONS].sort()).toEqual(
      tenantActions
        .filter((action) => !addedWithPoolChains.includes(action))
        .sort(),
    );
  });

  it("lists exactly the user pool actions of the audit service for pool logs", () => {
    const poolActions = Object.entries(ACTIONS)
      .filter(([, rule]) => rule.chain === "pool")
      .map(([action]) => action);
    expect([...POOL_AUDIT_ACTIONS].sort()).toEqual(poolActions.sort());
  });
});

describe("internal routes", () => {
  it("/metrics does not exist on the public port, under any spelling", async () => {
    const { key } = await createTenantWithKey(app);

    for (const url of [
      "/metrics",
      "/v1/metrics",
      "/admin/metrics",
      "/v1/../metrics",
      "/v1/storage/..%2f..%2fmetrics",
    ]) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${key}` },
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.body).not.toMatch(/http_requests_total|# HELP/);
    }
  });
});

describe("redaction", () => {
  it("logs never contain API keys, the admin token, the audit token, secret values or Authorization headers", async () => {
    const logs = captureLogs();
    const secrets = await startContractService(secretsContract, () => ({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify({
        name: "db-password",
        version: 1,
        value: "the-secret-value-xyz",
        createdAt: "2026-11-05T09:30:00.000Z",
      }),
    }));
    const { db } = await createTestDatabase();
    app = await startGateway({
      db,
      secretsUrl: secrets.url,
      audit,
      logger: { level: "debug", stream: logs.stream },
    });
    const { key } = await createTenantWithKey(app);

    await app.inject({
      method: "GET",
      url: "/v1/secrets/db-password",
      headers: {
        authorization: `Bearer ${key}`,
        cookie: "session=abc123cookie",
      },
    });
    await app.inject({
      method: "PUT",
      url: "/v1/secrets/db-password",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      payload: { value: "the-secret-value-xyz" },
    });
    await app.inject({
      method: "GET",
      url: "/v1/secrets/x",
      headers: { authorization: `Bearer ${key}x` },
    });

    const text = logs.text();
    expect(text).toContain("request completed");
    for (const secret of [
      key,
      key.slice(-43),
      adminHeaders.authorization.slice(7),
      AUDIT_TOKEN,
      "the-secret-value-xyz",
      "abc123cookie",
      "Bearer ",
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});

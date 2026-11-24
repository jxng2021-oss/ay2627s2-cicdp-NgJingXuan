import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ACTION_NAMES } from "../../services/audit/src/actions.js";
import type { Database } from "../../services/audit/src/db/client.js";
import { auditEvents } from "../../services/audit/src/db/schema.js";
import {
  captureLogs,
  createTestDatabase,
  readEvents,
  secretRead,
  sendEvent,
  startAudit,
  TOKENS,
} from "./helpers.js";

describe("POST /internal/events", () => {
  it("saves an event with every field, in the tenant's chain", async () => {
    const { db } = await createTestDatabase();
    const app = await startAudit({ db });
    const tenant = randomUUID();
    const event = secretRead(tenant);

    const response = await sendEvent(app, "secrets", event);

    expect(response.statusCode).toBe(201);
    const [row] = await db.select().from(auditEvents);
    expect(row).toMatchObject({
      chain: tenant,
      seq: 1,
      tenantId: tenant,
      service: "secrets",
      actorType: "api_key",
      actorId: event.actorId,
      action: "secret.read",
      resourceType: "secret",
      resourceId: "db-password",
      outcome: "success",
      requestId: event.requestId,
      sourceIp: "203.0.113.7",
    });
    expect(row!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.prevHash).toBe("0".repeat(64));
  });

  it("puts platform events in the platform chain", async () => {
    const { db } = await createTestDatabase();
    const app = await startAudit({ db });

    await sendEvent(app, "secrets", {
      action: "secrets.unsealed",
      outcome: "success",
      actorType: "operator",
    });

    const [row] = await db.select().from(auditEvents);
    expect(row).toMatchObject({ chain: "platform", tenantId: null });
  });

  it.each([
    ["an unknown service", "billing", TOKENS.gateway],
    ["no service name", "", TOKENS.gateway],
    ["no token", "secrets", null],
    ["a wrong token", "secrets", "x".repeat(40)],
    ["another service's token", "secrets", TOKENS.storage],
    ["an almost-right token", "secrets", `${TOKENS.secrets.slice(0, -1)}X`],
  ])("refuses %s with 403", async (_case, service, token) => {
    const { db } = await createTestDatabase();
    const app = await startAudit({ db });

    const response = await sendEvent(
      app,
      service,
      secretRead(randomUUID()),
      token,
    );

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(await db.select().from(auditEvents)).toEqual([]);
  });

  it("only lets each service record its own actions", async () => {
    const app = await startAudit();

    const storage = await sendEvent(app, "storage", secretRead(randomUUID()));
    const gateway = await sendEvent(app, "gateway", {
      action: "secrets.sealed",
      outcome: "success",
      actorType: "operator",
    });

    expect([storage.statusCode, gateway.statusCode]).toEqual([403, 403]);
  });

  it.each([
    ["an unknown action", { action: "secret.exported" }],
    ["an unknown outcome", { outcome: "maybe" }],
    ["an unknown actor type", { actorType: "robot" }],
    ["an extra field", { value: "the secret value" }],
    ["a request body field", { body: { value: "x" } }],
    ["a bad tenant ID", { tenantId: "tenant-a" }],
    ["a bad actor ID", { actorId: "sk_test_abc" }],
    ["a resource ID with spaces", { resourceId: "a b" }],
    ["a bad request ID", { requestId: "123" }],
    ["a source IP that isn't one", { sourceIp: "999.1.1.1" }],
    ["a tenant action without a tenant", { tenantId: undefined }],
  ])("refuses %s with 400", async (_case, change) => {
    const { db } = await createTestDatabase();
    const app = await startAudit({ db });
    const event: Record<string, unknown> = {
      ...secretRead(randomUUID()),
      ...change,
    };
    if ("tenantId" in change && change.tenantId === undefined) {
      delete event.tenantId;
    }

    const response = await sendEvent(app, "secrets", event);

    expect(response.statusCode).toBe(400);
    expect(await db.select().from(auditEvents)).toEqual([]);
  });

  it("has a fixed list of actions", () => {
    expect(ACTION_NAMES).toEqual(
      expect.arrayContaining([
        "tenant.created",
        "tenant.suspended",
        "api_key.created",
        "api_key.revoked",
        "secret.created",
        "secret.read",
        "secret.rotated",
        "secret.deleted",
        "proxy_connection.created",
        "proxy_connection.deleted",
        "proxy_connection.used",
        "file.uploaded",
        "file.downloaded",
        "file.deleted",
        "secrets.initialised",
        "secrets.unsealed",
        "secrets.sealed",
        "file.access_denied",
      ]),
    );
  });

  it("refuses traffic from outside the internal network", async () => {
    const app = await startAudit();

    const response = await app.inject({
      method: "POST",
      url: "/internal/events",
      remoteAddress: "203.0.113.9",
      headers: {
        "x-audit-service": "secrets",
        authorization: `Bearer ${TOKENS.secrets}`,
      },
      payload: secretRead(randomUUID()),
    });

    expect(response.statusCode).toBe(403);
  });

  it("answers 503 (never a database error) when its database is down", async () => {
    const failing = {
      transaction: () =>
        Promise.reject(new Error("connect ECONNREFUSED db:5432")),
    } as unknown as Database;
    const app = await startAudit({ db: failing });

    const response = await sendEvent(app, "secrets", secretRead(randomUUID()));

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toMatch(/ECONNREFUSED|5432/);
  });
});

describe("GET /events (for the gateway)", () => {
  it("returns only that tenant's events, newest first, never the platform chain", async () => {
    const app = await startAudit();
    const a = randomUUID();
    const b = randomUUID();
    await sendEvent(app, "secrets", secretRead(a, "first"));
    await sendEvent(app, "secrets", secretRead(a, "second"));
    await sendEvent(app, "secrets", secretRead(b, "other-tenant"));
    await sendEvent(app, "secrets", {
      action: "secrets.sealed",
      outcome: "success",
      actorType: "operator",
    });

    const response = await readEvents(app, a);

    expect(response.statusCode).toBe(200);
    const body = response.json<{ events: { resourceId: string }[] }>();
    expect(body.events.map((e) => e.resourceId)).toEqual(["second", "first"]);
    expect(response.body).not.toMatch(/"hash"|prevHash|"chain"/);
    expect((await readEvents(app, "platform")).statusCode).toBe(400);
  });

  it("filters by action, outcome, resource and time, with cursor pagination", async () => {
    const app = await startAudit();
    const tenant = randomUUID();
    for (const name of ["a", "b", "c"]) {
      await sendEvent(app, "secrets", secretRead(tenant, name));
    }
    await sendEvent(app, "secrets", {
      ...secretRead(tenant, "a"),
      action: "secret.deleted",
    });
    await sendEvent(app, "storage", {
      action: "file.uploaded",
      outcome: "failure",
      actorType: "api_key",
      tenantId: tenant,
      resourceId: randomUUID(),
    });

    const ids = async (query: string) =>
      (await readEvents(app, tenant, query))
        .json<{ events: { action: string; resourceId: string }[] }>()
        .events.map((e) => `${e.action}:${e.resourceId.slice(0, 1)}`);

    expect(await ids("?action=secret.read")).toEqual([
      "secret.read:c",
      "secret.read:b",
      "secret.read:a",
    ]);
    expect(await ids("?outcome=failure")).toHaveLength(1);
    expect(
      await ids("?action=secret.read&action=secret.deleted&outcome=success"),
    ).toEqual([
      "secret.deleted:a",
      "secret.read:c",
      "secret.read:b",
      "secret.read:a",
    ]);
    expect(await ids("?resourceType=secret&resourceId=a")).toEqual([
      "secret.deleted:a",
      "secret.read:a",
    ]);
    expect(
      await ids("?from=2000-01-01T00:00:00Z&to=2001-01-01T00:00:00Z"),
    ).toEqual([]);

    const first = (await readEvents(app, tenant, "?limit=2")).json<{
      events: unknown[];
      nextCursor: string;
    }>();
    const second = (
      await readEvents(app, tenant, `?limit=2&cursor=${first.nextCursor}`)
    ).json<{ events: unknown[]; nextCursor: string | null }>();
    const third = (
      await readEvents(app, tenant, `?limit=2&cursor=${second.nextCursor}`)
    ).json<{ events: unknown[]; nextCursor: string | null }>();
    expect([
      first.events.length,
      second.events.length,
      third.events.length,
    ]).toEqual([2, 2, 1]);
    expect(third.nextCursor).toBeNull();
  });

  it("refuses bad filters (400) and other services (403)", async () => {
    const app = await startAudit();
    const tenant = randomUUID();

    for (const query of [
      "?action=nope",
      "?limit=0",
      "?from=yesterday",
      "?cursor=abc",
      "?extra=1",
    ]) {
      expect((await readEvents(app, tenant, query)).statusCode).toBe(400);
    }
    const asStorage = await app.inject({
      method: "GET",
      url: "/events",
      headers: {
        "x-audit-service": "storage",
        authorization: `Bearer ${TOKENS.storage}`,
        "x-tenant-id": tenant,
      },
    });
    expect(asStorage.statusCode).toBe(403);
  });
});

describe("logs", () => {
  it("never contain tokens", async () => {
    const logs = captureLogs();
    const app = await startAudit({ logStream: logs.stream });
    const tenant = randomUUID();
    await sendEvent(app, "secrets", secretRead(tenant, "very-private-name"));
    await sendEvent(
      app,
      "secrets",
      secretRead(tenant),
      "wrong-token-".repeat(4),
    );

    for (const token of Object.values(TOKENS)) {
      expect(logs.text()).not.toContain(token);
    }
    expect(logs.text()).not.toContain("wrong-token-");
  });

  it("writes one JSON line per request with service, version, request ID, route, status and duration", async () => {
    const logs = captureLogs();
    const app = await startAudit({ logStream: logs.stream });
    const requestId = randomUUID();

    await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": requestId },
    });

    const line = logs
      .text()
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.msg === "request completed");
    expect(line).toMatchObject({
      service: "audit",
      version: "dev",
      requestId,
      route: "/health",
      status: 200,
    });
    expect(typeof line?.durationMs).toBe("number");
  });
});

describe("dashboard user events", () => {
  it("a failed login without a known workspace goes to the platform chain; with one, to that tenant's", async () => {
    const { db } = await createTestDatabase();
    const app = await startAudit({ db });
    const tenant = randomUUID();

    const unknown = await sendEvent(app, "gateway", {
      action: "user.login_failed",
      outcome: "failure",
      actorType: "user",
      sourceIp: "203.0.113.5",
    });
    const known = await sendEvent(app, "gateway", {
      action: "user.login_failed",
      outcome: "failure",
      actorType: "user",
      actorId: randomUUID(),
      tenantId: tenant,
    });

    expect([unknown.statusCode, known.statusCode]).toEqual([201, 201]);
    const rows = await db.select().from(auditEvents);
    expect(rows.map((r) => r.chain).sort()).toEqual(
      [tenant, "platform"].sort(),
    );
  });

  it("only the secrets service may record a reveal", async () => {
    const app = await startAudit();
    const event = {
      ...secretRead(randomUUID()),
      action: "secret.revealed",
      actorType: "user",
    };

    expect((await sendEvent(app, "gateway", event)).statusCode).toBe(403);
    expect((await sendEvent(app, "secrets", event)).statusCode).toBe(201);
  });
});

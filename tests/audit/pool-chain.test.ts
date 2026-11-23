import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { auditEvents } from "../../services/audit/src/db/schema.js";
import {
  createTestDatabase,
  readEvents,
  secretRead,
  sendEvent,
  startAudit,
  TOKENS,
} from "./helpers.js";

const poolEvent = (
  tenantId: string,
  poolId: string,
  action = "pool_user.logged_in",
) => ({
  action,
  outcome: "success",
  actorType: "api_key",
  actorId: randomUUID(),
  tenantId,
  poolId,
  resourceId: randomUUID(),
  requestId: randomUUID(),
});

function readPoolEvents(
  app: FastifyInstance,
  tenantId: string,
  poolId: string,
  query = "",
) {
  return app.inject({
    method: "GET",
    url: `/pools/${poolId}/events${query}`,
    headers: {
      "x-audit-service": "gateway",
      authorization: `Bearer ${TOKENS.gateway}`,
      "x-tenant-id": tenantId,
    },
  });
}

describe("each user pool has its own chain", () => {
  it("records pool user and role events in pool:<poolId>, apart from the workspace's chain", async () => {
    const { db } = await createTestDatabase();
    const app = await startAudit({ db });
    const tenant = randomUUID();
    const pool = randomUUID();

    expect(
      (await sendEvent(app, "identity", poolEvent(tenant, pool))).statusCode,
    ).toBe(201);
    expect(
      (
        await sendEvent(
          app,
          "identity",
          poolEvent(tenant, pool, "pool_role.created"),
        )
      ).statusCode,
    ).toBe(201);
    await sendEvent(app, "secrets", secretRead(tenant));

    const rows = await db.select().from(auditEvents);
    expect(
      rows
        .filter((row) => row.chain === `pool:${pool}`)
        .map((row) => [row.seq, row.tenantId]),
    ).toEqual([
      [1, tenant],
      [2, tenant],
    ]);
    expect(rows.find((row) => row.chain === tenant)?.action).toBe(
      "secret.read",
    );

    const workspace = (await readEvents(app, tenant)).json<{
      events: { action: string }[];
    }>();
    expect(workspace.events.map((e) => e.action)).toEqual(["secret.read"]);

    const poolLog = (await readPoolEvents(app, tenant, pool)).json<{
      events: { action: string }[];
    }>();
    expect(poolLog.events.map((e) => e.action)).toEqual([
      "pool_role.created",
      "pool_user.logged_in",
    ]);
  });

  it("refuses a pool event without a poolId, and a poolId on any other action", async () => {
    const app = await startAudit();
    const tenant = randomUUID();
    const withoutPool: Record<string, unknown> = poolEvent(
      tenant,
      randomUUID(),
    );
    delete withoutPool.poolId;

    const missing = await sendEvent(app, "identity", withoutPool);
    const extra = await sendEvent(app, "secrets", {
      ...secretRead(tenant),
      poolId: randomUUID(),
    });

    expect([missing.statusCode, extra.statusCode]).toEqual([400, 400]);
  });

  it("only the pool's own tenant reads its chain", async () => {
    const app = await startAudit();
    const tenant = randomUUID();
    const pool = randomUUID();
    await sendEvent(app, "identity", poolEvent(tenant, pool));

    const other = await readPoolEvents(app, randomUUID(), pool);
    expect(other.statusCode).toBe(200);
    expect(other.json<{ events: unknown[] }>().events).toEqual([]);

    const byStorage = await app.inject({
      method: "GET",
      url: `/pools/${pool}/events`,
      headers: {
        "x-audit-service": "storage",
        authorization: `Bearer ${TOKENS.storage}`,
        "x-tenant-id": tenant,
      },
    });
    expect(byStorage.statusCode).toBe(403);
  });

  it("filters and pages a pool's events like the workspace's", async () => {
    const app = await startAudit();
    const tenant = randomUUID();
    const pool = randomUUID();
    for (let i = 0; i < 3; i++)
      await sendEvent(app, "identity", poolEvent(tenant, pool));
    await sendEvent(
      app,
      "identity",
      poolEvent(tenant, pool, "pool_user.unlocked"),
    );

    const first = (await readPoolEvents(app, tenant, pool, "?limit=2")).json<{
      events: unknown[];
      nextCursor: string;
    }>();
    expect(first.events).toHaveLength(2);
    const rest = (
      await readPoolEvents(
        app,
        tenant,
        pool,
        `?limit=2&cursor=${first.nextCursor}`,
      )
    ).json<{ events: unknown[] }>();
    expect(rest.events).toHaveLength(2);

    const unlocks = (
      await readPoolEvents(app, tenant, pool, "?action=pool_user.unlocked")
    ).json<{ events: unknown[] }>();
    expect(unlocks.events).toHaveLength(1);
  });
});

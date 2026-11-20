import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  appendEvent,
  verifyChain,
} from "../../services/audit/src/models/event.model.js";
import {
  createTestDatabase,
  HMAC_KEY,
  secretRead,
  sendEvent,
  startAudit,
} from "./helpers.js";

async function chainOf(count: number) {
  const { db, client } = await createTestDatabase();
  const tenant = randomUUID();
  for (let i = 1; i <= count; i++) {
    await appendEvent(db, HMAC_KEY, {
      chain: tenant,
      tenantId: tenant,
      service: "secrets",
      actorType: "api_key",
      actorId: randomUUID(),
      action: "secret.read",
      resourceType: "secret",
      resourceId: `secret-${i}`,
      outcome: "success",
      requestId: randomUUID(),
      sourceIp: "198.51.100.1",
    });
  }
  const sql = (query: string) => client.exec(query);
  return { db, tenant, sql };
}

describe("verifying a chain", () => {
  it("passes for an untouched chain, and an empty one", async () => {
    const { db, tenant } = await chainOf(5);

    expect(await verifyChain(db, HMAC_KEY, tenant)).toEqual({
      chain: tenant,
      ok: true,
      checked: 5,
    });
    expect((await verifyChain(db, HMAC_KEY, randomUUID())).ok).toBe(true);
  });

  it.each([
    ["the action", "action = 'secret.deleted'"],
    ["the outcome", "outcome = 'denied'"],
    ["the actor", `actor_id = '${randomUUID()}'`],
    ["the time", "occurred_at = occurred_at - interval '1 hour'"],
    ["the source IP", "source_ip = '10.0.0.1'"],
    ["the request ID", "request_id = null"],
  ])("finds a middle entry whose %s was changed", async (_field, change) => {
    const { db, tenant, sql } = await chainOf(5);
    await sql(
      `update audit_events set ${change} where chain = '${tenant}' and seq = 3`,
    );

    const result = await verifyChain(db, HMAC_KEY, tenant);

    expect(result).toMatchObject({
      ok: false,
      checked: 2,
      firstBroken: {
        seq: 3,
        reason: expect.stringMatching(/changed/) as string,
      },
    });
  });

  it("finds a changed entry even if its own hash was recomputed without the key", async () => {
    const { db, tenant, sql } = await chainOf(4);
    await sql(
      `update audit_events set outcome = 'denied', hash = encode(sha256(convert_to(id::text, 'UTF8')), 'hex') where chain = '${tenant}' and seq = 2`,
    );

    expect((await verifyChain(db, HMAC_KEY, tenant)).firstBroken?.seq).toBe(2);
  });

  it("finds a removed middle entry", async () => {
    const { db, tenant, sql } = await chainOf(5);
    await sql(`delete from audit_events where chain = '${tenant}' and seq = 3`);

    const result = await verifyChain(db, HMAC_KEY, tenant);

    expect(result.ok).toBe(false);
    expect(result.firstBroken).toMatchObject({
      seq: 4,
      reason: expect.stringMatching(/entry 3 is missing/) as string,
    });
  });

  it("finds reordered entries", async () => {
    const { db, tenant, sql } = await chainOf(5);
    await sql(`
      update audit_events set seq = -2 where chain = '${tenant}' and seq = 2;
      update audit_events set seq = 2 where chain = '${tenant}' and seq = 4;
      update audit_events set seq = 4 where chain = '${tenant}' and seq = -2;
    `);

    expect((await verifyChain(db, HMAC_KEY, tenant)).firstBroken?.seq).toBe(2);
  });

  it("finds an entry copied in from another chain", async () => {
    const one = await chainOf(3);
    const other = randomUUID();
    await one.sql(
      `insert into audit_events select gen_random_uuid(), '${other}', seq, occurred_at, tenant_id, service, actor_type, actor_id, action, resource_type, resource_id, outcome, request_id, source_ip, prev_hash, hash from audit_events where chain = '${one.tenant}' and seq = 1`,
    );

    expect((await verifyChain(one.db, HMAC_KEY, other)).ok).toBe(false);
  });

  it("can't tell if the newest entries were deleted (documented limit)", async () => {
    const { db, tenant, sql } = await chainOf(5);
    await sql(
      `delete from audit_events where chain = '${tenant}' and seq >= 4`,
    );

    expect(await verifyChain(db, HMAC_KEY, tenant)).toMatchObject({
      ok: true,
      checked: 3,
    });
  });

  it("fails with a different key", async () => {
    const { db, tenant } = await chainOf(2);

    expect(
      (await verifyChain(db, "another-key-0123456789abcdef0123456789", tenant))
        .firstBroken?.seq,
    ).toBe(1);
  });
});

describe("simultaneous events", () => {
  it("still form one valid chain per tenant, with no gaps or forks", async () => {
    const { db } = await createTestDatabase();
    const app = await startAudit({ db });
    const tenants = [randomUUID(), randomUUID()];

    const responses = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        sendEvent(app, "secrets", secretRead(tenants[i % 2]!, `s-${i}`)),
      ),
    );

    expect(responses.every((r) => r.statusCode === 201)).toBe(true);
    for (const tenant of tenants) {
      expect(await verifyChain(db, HMAC_KEY, tenant)).toEqual({
        chain: tenant,
        ok: true,
        checked: 20,
      });
    }
  });
});

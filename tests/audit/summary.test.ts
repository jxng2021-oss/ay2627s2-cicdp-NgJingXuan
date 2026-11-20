import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  readEvents,
  secretRead,
  sendEvent,
  startAudit,
  TOKENS,
} from "./helpers.js";

const call = (tenantId: string, name: string, outcome = "success") => ({
  action: "proxy_connection.used",
  outcome,
  actorType: "api_key",
  tenantId,
  resourceId: name,
});

function summary(
  app: Awaited<ReturnType<typeof startAudit>>,
  tenantId: string,
  query: string,
  service = "gateway",
) {
  return app.inject({
    method: "GET",
    url: `/events/summary${query}`,
    headers: {
      "x-audit-service": service,
      authorization: `Bearer ${TOKENS[service as keyof typeof TOKENS]}`,
      "x-tenant-id": tenantId,
    },
  });
}

const now = () => new Date();
const range = (from: Date, to: Date) =>
  `?from=${from.toISOString()}&to=${to.toISOString()}`;
const today = () => now().toISOString().slice(0, 10);

describe("GET /events/summary", () => {
  it("counts a tenant's events per day, action and outcome, and calls per connection", async () => {
    const app = await startAudit();
    const tenant = randomUUID();
    const other = randomUUID();
    for (const event of [
      call(tenant, "payments"),
      call(tenant, "payments"),
      call(tenant, "payments", "failure"),
      call(tenant, "sms"),
      {
        action: "proxy_connection.denied",
        outcome: "denied",
        actorType: "api_key",
        tenantId: tenant,
        resourceId: "payments",
      },
      call(other, "payments"),
    ]) {
      expect((await sendEvent(app, "gateway", event)).statusCode).toBe(201);
    }
    expect(
      (await sendEvent(app, "secrets", secretRead(tenant))).statusCode,
    ).toBe(201);

    const from = new Date(now().getTime() - 24 * 60 * 60 * 1000);
    const to = new Date(now().getTime() + 60 * 1000);
    const response = await summary(app, tenant, range(from, to));
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      daily: { day: string; action: string; outcome: string; count: number }[];
      connections: {
        resourceId: string;
        action: string;
        outcome: string;
        count: number;
      }[];
    }>();

    const day = today();
    expect(body.daily).toEqual(
      expect.arrayContaining([
        { day, action: "proxy_connection.used", outcome: "success", count: 3 },
        { day, action: "proxy_connection.used", outcome: "failure", count: 1 },
        {
          day,
          action: "proxy_connection.denied",
          outcome: "denied",
          count: 1,
        },
        { day, action: "secret.read", outcome: "success", count: 1 },
      ]),
    );
    expect(body.daily).toHaveLength(4);
    expect(
      body.connections.find(
        (c) => c.resourceId === "payments" && c.outcome === "success",
      )?.count,
    ).toBe(2);
    expect(body.connections).toHaveLength(4);
    expect(response.body).not.toMatch(/requestId|sourceIp|hash|actorId/);
  });

  it("counts nothing outside the time range", async () => {
    const app = await startAudit();
    const tenant = randomUUID();
    await sendEvent(app, "gateway", call(tenant, "payments"));
    const from = new Date(now().getTime() + 60 * 1000);
    const to = new Date(now().getTime() + 120 * 1000);
    const response = await summary(app, tenant, range(from, to));
    expect(response.json()).toEqual({ daily: [], connections: [] });
  });

  it("refuses other services, a missing tenant and bad ranges", async () => {
    const app = await startAudit();
    const tenant = randomUUID();
    const from = new Date(now().getTime() - 1000);
    const to = now();

    expect(
      (await summary(app, tenant, range(from, to), "secrets")).statusCode,
    ).toBe(403);
    expect((await summary(app, "platform", range(from, to))).statusCode).toBe(
      400,
    );
    expect((await summary(app, tenant, range(to, from))).statusCode).toBe(400);
    const long = new Date(to.getTime() - 201 * 24 * 60 * 60 * 1000);
    expect((await summary(app, tenant, range(long, to))).statusCode).toBe(400);
    expect((await summary(app, tenant, "")).statusCode).toBe(400);
    expect((await readEvents(app, tenant)).statusCode).toBe(200);
  });
});

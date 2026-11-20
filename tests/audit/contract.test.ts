import { randomUUID } from "node:crypto";
import type { LightMyRequestResponse } from "fastify";
import { describe, expect, it } from "vitest";
import { Contract, loadSpec } from "../../api/validate.js";
import type { Database } from "../../services/audit/src/db/client.js";
import {
  secretRead,
  sendEvent,
  readEvents,
  startAudit,
  TOKENS,
} from "./helpers.js";

const contract = new Contract(loadSpec("api/internal/audit.openapi.json"));

function expectContract(
  method: string,
  url: string,
  response: LightMyRequestResponse,
) {
  expect(
    contract.checkResponse(method, url, {
      statusCode: response.statusCode,
      headers: response.headers,
      body: response.body,
    }),
  ).toEqual([]);
}

describe("the audit service meets the internal contract", () => {
  it("/health and /ready, also with the database down", async () => {
    const app = await startAudit();
    const down = await startAudit({
      db: {
        execute: () => Promise.reject(new Error("down")),
      } as unknown as Database,
    });

    for (const [instance, url, status] of [
      [app, "/health", 200],
      [app, "/ready", 200],
      [down, "/ready", 503],
    ] as const) {
      const response = await instance.inject({ method: "GET", url });
      expect(response.statusCode).toBe(status);
      expectContract("GET", url, response);
    }
  });

  it("POST /internal/events: 201, 400 and 403", async () => {
    const app = await startAudit();
    const event = secretRead(randomUUID());
    const headers = {
      "x-audit-service": "secrets",
      authorization: `Bearer ${TOKENS.secrets}`,
    };
    expect(
      contract.checkRequest(
        "POST",
        "/internal/events",
        headers,
        JSON.stringify(event),
      ),
    ).toEqual([]);
    expect(
      contract.checkRequest(
        "POST",
        "/internal/events",
        headers,
        JSON.stringify({ ...event, action: "secret.exported" }),
      ),
    ).not.toEqual([]);

    const responses = [
      await sendEvent(app, "secrets", event),
      await sendEvent(app, "secrets", { ...event, outcome: "maybe" }),
      await sendEvent(app, "secrets", event, "wrong-token".repeat(4)),
    ];

    expect(responses.map((r) => r.statusCode)).toEqual([201, 400, 403]);
    for (const response of responses)
      expectContract("POST", "/internal/events", response);
  });

  it("GET /events: 200 and 400", async () => {
    const app = await startAudit();
    const tenant = randomUUID();
    await sendEvent(app, "secrets", secretRead(tenant));

    const ok = await readEvents(app, tenant, "?limit=10");
    const bad = await readEvents(app, tenant, "?limit=0");

    expect([ok.statusCode, bad.statusCode]).toEqual([200, 400]);
    expectContract("GET", "/events", ok);
    expectContract("GET", "/events", bad);
  });

  it("GET /events/summary: 200 and 400", async () => {
    const app = await startAudit();
    const tenant = randomUUID();
    await sendEvent(app, "secrets", secretRead(tenant));
    const ask = (query: string) =>
      app.inject({
        method: "GET",
        url: `/events/summary${query}`,
        headers: {
          "x-audit-service": "gateway",
          authorization: `Bearer ${TOKENS.gateway}`,
          "x-tenant-id": tenant,
        },
      });
    const to = new Date(Date.now() + 60_000).toISOString();
    const from = new Date(Date.now() - 60_000).toISOString();

    const ok = await ask(`?from=${from}&to=${to}`);
    const bad = await ask(`?from=${to}&to=${from}`);

    expect([ok.statusCode, bad.statusCode]).toEqual([200, 400]);
    expectContract("GET", `/events/summary?from=${from}&to=${to}`, ok);
    expectContract("GET", "/events/summary", bad);
  });
});

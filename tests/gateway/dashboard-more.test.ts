import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { Browser, fakeSecrets } from "./dashboard-helpers.js";
import {
  createTestDatabase,
  expectError,
  FakeAudit,
  startGateway,
} from "./helpers.js";

let app: FastifyInstance;
let audit: FakeAudit;
let browser: Browser;
let workspace: string;

beforeEach(async () => {
  const { db } = await createTestDatabase();
  audit = new FakeAudit();
  const secrets = await fakeSecrets();
  app = await startGateway({
    db,
    audit,
    secretsUrl: secrets.url,
    proxy: { allowedHosts: ["127.0.0.1"], allowPrivateTargets: true },
  });
  browser = new Browser(app);
  workspace = await browser.signUp(`owner-${randomUUID()}@example.com`);
});

const ws = (path: string) => browser.ws(workspace, path);

describe("dashboard connections", () => {
  const connection = (extra: Record<string, unknown> = {}) => ({
    baseUrl: "https://127.0.0.1:9/v1",
    secretName: "stripe-key",
    headerName: "Authorization",
    headerPrefix: "Bearer ",
    ...extra,
  });

  it("creates, updates, reads usage of and removes a connection", async () => {
    const created = await browser.request("PUT", ws("/proxy-connections/pay"), {
      body: connection({
        policy: {
          rateLimit: { requests: 10, windowSeconds: 60 },
          amountLimit: { field: "amount", maxPerRequest: 100, maxPerDay: 1000 },
        },
      }),
    });
    expect(created.statusCode).toBe(201);
    const updated = await browser.request("PUT", ws("/proxy-connections/pay"), {
      body: connection({ headerPrefix: "" }),
    });
    expect(updated.statusCode).toBe(200);
    const withPolicy = await browser.request(
      "PUT",
      ws("/proxy-connections/pay"),
      {
        body: connection({
          policy: { rateLimit: { requests: 5, windowSeconds: 60 } },
        }),
      },
    );
    expect(withPolicy.statusCode).toBe(200);
    const usage = await browser.request(
      "GET",
      ws("/proxy-connections/pay/usage"),
    );
    expect(usage.statusCode).toBe(200);
    expect(usage.json()).toMatchObject({
      name: "pay",
      calls: { used: 0, limit: 5, windowSeconds: 60 },
    });
    const removed = await browser.request(
      "DELETE",
      ws("/proxy-connections/pay"),
    );
    expect(removed.statusCode).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(audit.events.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        "proxy_connection.created",
        "proxy_connection.updated",
        "proxy_connection.deleted",
      ]),
    );
  });

  it("answers 404 for a connection that doesn't exist", async () => {
    expectError(
      await browser.request("GET", ws("/proxy-connections/nope/usage")),
      404,
      "NOT_FOUND",
    );
    expectError(
      await browser.request("DELETE", ws("/proxy-connections/nope")),
      404,
      "NOT_FOUND",
    );
  });
});

describe("dashboard webhook endpoints", () => {
  const create = (body: Record<string, unknown>) =>
    browser.request("POST", ws("/webhooks"), {
      body: {
        name: "stripe",
        signingSecretName: "whsec",
        forwardUrl: null,
        ...body,
      },
    });

  it("refuses a taken name, a bad delivery address and too many endpoints", async () => {
    expect((await create({})).statusCode).toBe(201);
    expectError(await create({}), 409, "CONFLICT");
    expectError(
      await create({ name: "other", forwardUrl: "ftp://example.com" }),
      400,
      "BAD_REQUEST",
    );
    for (let i = 1; i < 10; i++) {
      expect((await create({ name: `stripe-${i}` })).statusCode).toBe(201);
    }
    const tooMany = await create({ name: "one-too-many" });
    expectError(tooMany, 409, "CONFLICT");
    expect(tooMany.body).toContain("at most 10 webhook endpoints");
  });

  it("updates, lists events of and deletes an endpoint", async () => {
    const { id } = (await create({})).json<{ id: string }>();
    const updated = await browser.request("PATCH", ws(`/webhooks/${id}`), {
      body: {
        signingSecretName: "whsec-2",
        forwardUrl: "https://127.0.0.1:9/hooks",
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      signingSecretName: "whsec-2",
      forwardUrl: "https://127.0.0.1:9/hooks",
    });
    const cleared = await browser.request("PATCH", ws(`/webhooks/${id}`), {
      body: { forwardUrl: null },
    });
    expect(cleared.json()).toMatchObject({ forwardUrl: null });
    expectError(
      await browser.request("PATCH", ws(`/webhooks/${id}`), {
        body: { forwardUrl: "not a url" },
      }),
      400,
      "BAD_REQUEST",
    );
    const events = await browser.request("GET", ws(`/webhooks/${id}/events`));
    expect(events.json()).toEqual({ events: [] });
    expectError(
      await browser.request(
        "POST",
        ws(`/webhooks/${id}/events/${randomUUID()}/redeliver`),
      ),
      404,
      "NOT_FOUND",
    );
    expect(
      (await browser.request("DELETE", ws(`/webhooks/${id}`))).statusCode,
    ).toBe(204);
  });

  it("answers 404 for an endpoint that doesn't exist", async () => {
    const missing = randomUUID();
    for (const [method, path, body] of [
      ["PATCH", `/webhooks/${missing}`, { signingSecretName: "x" }],
      ["DELETE", `/webhooks/${missing}`, undefined],
      ["GET", `/webhooks/${missing}/events`, undefined],
      [
        "POST",
        `/webhooks/${missing}/events/${randomUUID()}/redeliver`,
        undefined,
      ],
    ] as const) {
      expectError(
        await browser.request(method, ws(path), body ? { body } : {}),
        404,
        "NOT_FOUND",
      );
    }
  });

  it("an endpoint with a delivery address can't redeliver an unknown event", async () => {
    const { id } = (
      await create({ forwardUrl: "https://127.0.0.1:9/hooks" })
    ).json<{ id: string }>();
    expectError(
      await browser.request(
        "POST",
        ws(`/webhooks/${id}/events/${randomUUID()}/redeliver`),
      ),
      404,
      "NOT_FOUND",
    );
  });
});

import { describe, expect, it } from "vitest";
import type { Database } from "../../services/gateway/src/db/client.js";
import { MemoryRateLimitStore } from "../../services/gateway/src/rate-limit.js";
import {
  adminHeaders,
  captureLogs,
  createTenantWithKey,
  createTestDatabase,
  expectError,
  startFakeStorage,
  startGateway,
} from "./helpers.js";

async function setup() {
  const { db } = await createTestDatabase();
  const storageUrl = await startFakeStorage((_req, res) => res.end("ok"));
  const store = new MemoryRateLimitStore();
  const logs = captureLogs();
  const tenant = await createTenantWithKey(await startGateway({ db }));
  const app = await startGateway({
    db,
    storageUrl,
    rateLimitStore: store,
    rateLimits: { requestsPerKey: 1, failedAuthPerIp: 1, adminPerIp: 1 },
    logger: { level: "info", stream: logs.stream },
  });
  store.fail = true;
  const get = (key: string) =>
    app.inject({
      method: "GET",
      url: "/v1/storage/files/00000000-0000-4000-8000-000000000000",
      headers: { authorization: `Bearer ${key}` },
    });
  return { app, tenant, logs, get };
}

describe("when Redis is down", () => {
  it("keeps serving requests with a valid key, without rate limits", async () => {
    const { tenant, get } = await setup();

    const responses = [
      await get(tenant.key),
      await get(tenant.key),
      await get(tenant.key),
    ];

    expect(responses.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(responses[0]?.headers["ratelimit-limit"]).toBeUndefined();
  });

  it("logs a clear warning, once rather than for every request", async () => {
    const { tenant, get, logs } = await setup();

    await get(tenant.key);
    await get(tenant.key);

    const warnings = logs
      .text()
      .split("\n")
      .filter((line) => line.includes("WITHOUT rate limits"));
    expect(warnings).toHaveLength(1);
  });

  it("refuses failed key attempts with 503, since they can't be counted", async () => {
    const { get } = await setup();

    const response = await get("wrong");

    expectError(response, 503, "SERVICE_UNAVAILABLE");
    expect(response.headers["retry-after"]).toBeDefined();
  });

  it("refuses admin requests with 503, even with the right token", async () => {
    const { app } = await setup();

    const response = await app.inject({
      method: "POST",
      url: "/admin/tenants",
      headers: adminHeaders,
      payload: { name: "x" },
    });

    expectError(
      response,
      503,
      "SERVICE_UNAVAILABLE",
      "The admin API is temporarily unavailable",
    );
  });

  it("reports itself as degraded, but still ready, on /ready", async () => {
    const { app } = await setup();

    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "degraded",
      checks: { postgres: "up", redis: "down" },
    });
  });

  it("keeps GET /health a simple liveness check", async () => {
    const { app } = await setup();

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });
});

describe("readiness", () => {
  it("is ready when Postgres and Redis are up", async () => {
    const { db } = await createTestDatabase();
    const app = await startGateway({ db });

    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ready",
      checks: { postgres: "up", redis: "up" },
    });
  });

  it("is not ready without Postgres, and reveals no connection details", async () => {
    const brokenDb = {
      execute: () =>
        Promise.reject(
          new Error(
            "connect ECONNREFUSED postgres://platform:s3cret@db-internal:5432",
          ),
        ),
    } as unknown as Database;
    const app = await startGateway({ db: brokenDb });

    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: "not_ready",
      checks: { postgres: "down", redis: "up" },
    });
    expect(response.body).not.toMatch(/ECONNREFUSED|s3cret|db-internal|5432/);
  });
});

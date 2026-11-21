import { describe, expect, it } from "vitest";
import type { RateLimitSettings } from "../../services/gateway/src/limits.js";
import { MemoryRateLimitStore } from "../../services/gateway/src/rate-limit.js";
import {
  adminHeaders,
  createTenantWithKey,
  createTestDatabase,
  expectError,
  startFakeStorage,
  startGateway,
} from "./helpers.js";

const WINDOW_MS = 60_000;

async function setup(rateLimits: Partial<RateLimitSettings>) {
  const { db } = await createTestDatabase();
  const storageUrl = await startFakeStorage((req, res) => {
    req.resume();
    req.on("end", () => res.end("ok"));
  });
  const setupApp = await startGateway({ db });
  const a = await createTenantWithKey(setupApp, "A");
  const b = await createTenantWithKey(setupApp, "B");
  let now = Date.now();
  const app = await startGateway({
    db,
    storageUrl,
    rateLimitStore: new MemoryRateLimitStore(() => now),
    rateLimits: { windowMs: WINDOW_MS, ...rateLimits },
  });
  const waitForNextWindow = () => {
    now += WINDOW_MS + 1;
  };
  const get = (key: string, headers: Record<string, string> = {}) =>
    app.inject({
      method: "GET",
      url: "/v1/storage/files/00000000-0000-4000-8000-000000000000",
      headers: { authorization: `Bearer ${key}`, ...headers },
    });
  return { app, a, b, get, waitForNextWindow };
}

describe("rate limit per API key", () => {
  it("allows the limit, then returns 429 with Retry-After, then recovers after the window", async () => {
    const { a, get, waitForNextWindow } = await setup({ requestsPerKey: 3 });

    const allowed = [await get(a.key), await get(a.key), await get(a.key)];
    expect(allowed.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(allowed.map((r) => r.headers["ratelimit-remaining"])).toEqual([
      "2",
      "1",
      "0",
    ]);
    expect(allowed[0]?.headers["ratelimit-limit"]).toBe("3");
    expect(
      Number(allowed[0]?.headers["ratelimit-reset"]),
    ).toBeGreaterThanOrEqual(1);

    const limited = await get(a.key);
    expectError(limited, 429, "RATE_LIMITED");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);

    waitForNextWindow();
    expect((await get(a.key)).statusCode).toBe(200);
  });

  it("counts each key separately", async () => {
    const { a, b, get } = await setup({ requestsPerKey: 2 });

    await get(a.key);
    await get(a.key);

    expect((await get(a.key)).statusCode).toBe(429);
    expect((await get(b.key)).statusCode).toBe(200);
  });

  it("never lets simultaneous requests exceed the limit", async () => {
    const { a, get } = await setup({ requestsPerKey: 5 });

    const responses = await Promise.all(
      Array.from({ length: 25 }, () => get(a.key)),
    );

    const codes = responses.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 200)).toHaveLength(5);
    expect(codes.filter((c) => c === 429)).toHaveLength(20);
  });

  it("limits uploads separately and more strictly", async () => {
    const { app, a } = await setup({ requestsPerKey: 100, uploadsPerKey: 2 });
    const upload = () =>
      app.inject({
        method: "POST",
        url: "/v1/storage/files",
        headers: {
          authorization: `Bearer ${a.key}`,
          "content-type": "application/octet-stream",
        },
        payload: Buffer.from("x"),
      });

    expect((await upload()).statusCode).toBe(200);
    expect((await upload()).statusCode).toBe(200);
    expectError(await upload(), 429, "RATE_LIMITED");
  });

  it("never limits /health or /ready", async () => {
    const { app } = await setup({
      requestsPerKey: 1,
      failedAuthPerIp: 1,
      adminPerIp: 1,
    });

    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        app.inject({ method: "GET", url: i % 2 ? "/health" : "/ready" }),
      ),
    );

    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
  });
});

describe("failed attempts per client IP", () => {
  it("blocks an IP after too many failed attempts", async () => {
    const { get } = await setup({ failedAuthPerIp: 3 });

    const failures = [
      await get("wrong"),
      await get("wrong"),
      await get("wrong"),
    ];
    expect(failures.map((r) => r.statusCode)).toEqual([401, 401, 401]);

    expectError(await get("wrong"), 429, "RATE_LIMITED");
  });

  it("gives a blocked IP the same answer for valid and invalid keys, so keys can't be tested", async () => {
    const { a, get } = await setup({ failedAuthPerIp: 2 });
    await get("wrong");
    await get("wrong");

    const withValidKey = await get(a.key);
    const withInvalidKey = await get(
      "sk_test_0123456789abcdef_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );

    expect(withValidKey.statusCode).toBe(429);
    expect(withInvalidKey.statusCode).toBe(429);
    expect(
      withValidKey.json<{ error: { message: string } }>().error.message,
    ).toBe(withInvalidKey.json<{ error: { message: string } }>().error.message);
  });

  it("doesn't count successful requests as failures", async () => {
    const { a, get } = await setup({ failedAuthPerIp: 2 });

    for (let i = 0; i < 5; i++) expect((await get(a.key)).statusCode).toBe(200);
  });

  it("can't be avoided with a fake X-Forwarded-For header", async () => {
    const { get } = await setup({ failedAuthPerIp: 2 });

    const responses = [];
    for (let i = 1; i <= 4; i++) {
      responses.push(
        await get("wrong", { "x-forwarded-for": `198.51.100.${i}` }),
      );
    }

    expect(responses.map((r) => r.statusCode)).toEqual([401, 401, 429, 429]);
  });

  it("uses X-Forwarded-For only from an explicitly trusted proxy", async () => {
    const { db } = await createTestDatabase();
    const app = await startGateway({
      db,
      trustProxy: ["127.0.0.1"],
      rateLimits: { failedAuthPerIp: 1, windowMs: WINDOW_MS },
    });
    const attempt = (clientIp: string) =>
      app.inject({
        method: "GET",
        url: "/v1/storage/files/00000000-0000-4000-8000-000000000000",
        headers: { authorization: "Bearer wrong", "x-forwarded-for": clientIp },
      });

    expect((await attempt("198.51.100.1")).statusCode).toBe(401);
    expect((await attempt("198.51.100.2")).statusCode).toBe(401);
    expect((await attempt("198.51.100.1")).statusCode).toBe(429);
  });
});

describe("admin rate limit", () => {
  it("limits admin requests per IP, even with the right token", async () => {
    const { app, a } = await setup({ adminPerIp: 2 });
    const list = () =>
      app.inject({
        method: "GET",
        url: `/admin/tenants/${a.tenantId}/api-keys`,
        headers: adminHeaders,
      });

    expect((await list()).statusCode).toBe(200);
    expect((await list()).statusCode).toBe(200);
    const limited = await list();
    expectError(limited, 429, "RATE_LIMITED");
    expect(limited.headers["retry-after"]).toBeDefined();
  });

  it("limits guesses of the admin token", async () => {
    const { app } = await setup({ adminPerIp: 2 });
    const guess = () =>
      app.inject({
        method: "POST",
        url: "/admin/tenants",
        headers: { authorization: "Bearer guess" },
        payload: { name: "x" },
      });

    expect((await guess()).statusCode).toBe(401);
    expect((await guess()).statusCode).toBe(401);
    expect((await guess()).statusCode).toBe(429);
  });
});

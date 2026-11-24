import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  expectPublicContract,
  secretsContract,
  serviceError,
  startContractService,
} from "./contract-helpers.js";
import {
  createTenantWithKey,
  createTestDatabase,
  expectError,
  FakeAudit,
  startFakeStorage,
  startGateway,
} from "./helpers.js";
import {
  amountFrom,
  policyProblem,
  routeAllowed,
  utcDay,
} from "../../services/gateway/src/services/policy.service.js";
import { MemoryRateLimitStore } from "../../services/gateway/src/rate-limit.js";

let app: FastifyInstance;
let audit: FakeAudit;
let store: MemoryRateLimitStore;
let now: number;
let secretReads: number;
let outsideCalls: { method: string; url: string; body: string }[];
let outsideStatus: number;
let upstreamPort: string;
let tenant: { tenantId: string; key: string };

const POLICY = {
  allowedRoutes: [
    { method: "POST", path: "/charges" },
    { method: "GET", path: "/charges/*" },
  ],
  rateLimit: { requests: 5, windowSeconds: 60 },
  amountLimit: { field: "amount", maxPerRequest: 500, maxPerDay: 1000 },
};

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(async () => {
  secretReads = 0;
  outsideCalls = [];
  outsideStatus = 201;
  now = Date.UTC(2026, 10, 12, 10, 0, 0);
  vi.useFakeTimers({ toFake: ["Date"], now });
  store = new MemoryRateLimitStore(() => now);
  audit = new FakeAudit();

  const outside = await startFakeStorage((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      outsideCalls.push({ method: req.method ?? "", url: req.url ?? "", body });
      res.writeHead(outsideStatus, { "content-type": "application/json" });
      res.end('{"id":"ch_1"}');
    });
  });
  upstreamPort = new URL(outside).port;
  const secrets = await startContractService(secretsContract, (req) => {
    secretReads++;
    const name = decodeURIComponent(req.url.split("/").pop() ?? "");
    if (name !== "payments-key") {
      return serviceError(req, 404, "NOT_FOUND", {
        "cache-control": "no-store",
      });
    }
    return {
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify({ name, version: 1, value: "sk_outside_key" }),
    };
  });

  const { db } = await createTestDatabase();
  app = await startGateway({
    db,
    secretsUrl: secrets.url,
    proxy: { allowedHosts: ["mock.test"], allowPrivateTargets: true },
    resolver: (host) =>
      host === "mock.test"
        ? Promise.resolve([{ address: "127.0.0.1", family: 4 }])
        : Promise.reject(new Error("ENOTFOUND")),
    rateLimitStore: store,
    audit,
  });
  tenant = await createTenantWithKey(app, "A");
});

async function saveConnection(
  policy?: object,
): Promise<LightMyRequestResponse> {
  const response = await app.inject({
    method: "PUT",
    url: "/v1/proxy-connections/payments",
    headers: {
      authorization: `Bearer ${tenant.key}`,
      "content-type": "application/json",
    },
    payload: {
      baseUrl: `http://mock.test:${upstreamPort}/api`,
      secretName: "payments-key",
      headerName: "Authorization",
      headerPrefix: "Bearer ",
      ...(policy ? { policy } : {}),
    },
  });
  expectPublicContract("PUT", "/v1/proxy-connections/payments", response);
  return response;
}

async function call(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  contentType = "application/json",
) {
  const url = `/v1/proxy/payments${path}`;
  const response = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${tenant.key}`,
      ...(body !== undefined ? { "content-type": contentType } : {}),
    },
    payload:
      body === undefined
        ? undefined
        : typeof body === "string"
          ? body
          : JSON.stringify(body),
  });
  if (response.statusCode !== outsideStatus || outsideCalls.length === 0) {
    expectPublicContract(method, url, response);
  }
  return response;
}

async function usage() {
  const response = await app.inject({
    method: "GET",
    url: "/v1/proxy-connections/payments/usage",
    headers: { authorization: `Bearer ${tenant.key}` },
  });
  expectPublicContract("GET", "/v1/proxy-connections/payments/usage", response);
  return response;
}

const denials = () =>
  audit.events.filter((e) => e.action === "proxy_connection.denied");

describe("connection policies", () => {
  it("a connection without a policy works exactly as before", async () => {
    const saved = await saveConnection();
    expect(saved.json<{ policy: unknown }>().policy).toBeNull();
    const response = await call("DELETE", "/anything/at/all");
    expect(response.statusCode).toBe(201);
    expect(secretReads).toBe(1);
  });

  it("saves and returns the policy, and refuses nonsense", async () => {
    const saved = await saveConnection(POLICY);
    expect(saved.statusCode).toBe(201);
    expect(saved.json<{ policy: unknown }>().policy).toEqual(POLICY);

    const backwards = await saveConnection({
      amountLimit: { field: "amount", maxPerRequest: 500, maxPerDay: 100 },
    });
    expectError(backwards, 400, "BAD_REQUEST");
    const unknownField = await saveConnection({ maxSpend: 1 });
    expectError(unknownField, 400, "BAD_REQUEST");
    const badPath = await saveConnection({
      allowedRoutes: [{ method: "POST", path: "charges/../admin" }],
    });
    expectError(badPath, 400, "BAD_REQUEST");
  });

  it("only allowed routes get through, and a refused call never reads the secret", async () => {
    await saveConnection(POLICY);
    const refused = await call("DELETE", "/charges/ch_1");
    expectError(refused, 403, "PROXY_POLICY_DENIED");
    expect(refused.json<{ error: { message: string } }>().error.message).toBe(
      "The connection's policy doesn't allow this method and path",
    );
    const wrongPath = await call("POST", "/refunds", { amount: 1 });
    expectError(wrongPath, 403, "PROXY_POLICY_DENIED");
    expect(secretReads).toBe(0);
    expect(outsideCalls).toEqual([]);

    const read = await call("GET", "/charges/ch_1?expand=x");
    expect(read.statusCode).toBe(201);
    expect(secretReads).toBe(1);

    expect(denials()).toHaveLength(2);
    expect(denials()[0]).toMatchObject({
      tenantId: tenant.tenantId,
      resourceId: "payments",
      outcome: "denied",
      requestId: refused.headers["x-request-id"],
    });
    expect(JSON.stringify(denials())).not.toContain("amount");
  });

  it("checks the amount per call, and never echoes it", async () => {
    await saveConnection(POLICY);
    const tooHigh = await call("POST", "/charges", { amount: 501 });
    expectError(tooHigh, 403, "PROXY_POLICY_DENIED");
    const { code, message } = tooHigh.json<{
      error: { code: string; message: string };
    }>().error;
    expect(`${code} ${message}`).not.toContain("501");
    for (const bad of [
      {},
      { amount: "100" },
      { amount: 1.5 },
      { amount: -5 },
      [100],
    ]) {
      expectError(
        await call("POST", "/charges", bad),
        403,
        "PROXY_POLICY_DENIED",
      );
    }
    const notJson = await call("POST", "/charges", "amount=100", "text/plain");
    expectError(notJson, 403, "PROXY_POLICY_DENIED");
    expect(secretReads).toBe(0);

    const ok = await call("POST", "/charges", { amount: 500, currency: "sgd" });
    expect(ok.statusCode).toBe(201);
    expect(JSON.parse(outsideCalls[0]!.body)).toEqual({
      amount: 500,
      currency: "sgd",
    });
  });

  it("reads the amount from a form body too (like Stripe), and passes the body on unchanged", async () => {
    await saveConnection(POLICY);
    const form = "application/x-www-form-urlencoded";

    for (const bad of [
      "amount=501&currency=sgd",
      "currency=sgd",
      "amount=100&amount=1",
      "amount=1.5",
      "amount=-5",
      "amount=0100",
    ]) {
      expectError(
        await call("POST", "/charges", bad, form),
        403,
        "PROXY_POLICY_DENIED",
      );
    }
    expect(secretReads).toBe(0);

    const ok = await call(
      "POST",
      "/charges",
      "amount=500&currency=sgd&metadata[order]=7",
      `${form}; charset=utf-8`,
    );
    expect(ok.statusCode).toBe(201);
    expect(outsideCalls[0]!.body).toBe(
      "amount=500&currency=sgd&metadata[order]=7",
    );
  });

  it("a form field with brackets works too, like Stripe Checkout's price", async () => {
    const field = "line_items[0][price_data][unit_amount]";
    const saved = await saveConnection({
      amountLimit: { field, maxPerRequest: 500, maxPerDay: 1000 },
    });
    expect(saved.statusCode).toBe(201);
    const form = "application/x-www-form-urlencoded";

    expectError(
      await call("POST", "/checkout", `${field}=501&mode=payment`, form),
      403,
      "PROXY_POLICY_DENIED",
    );
    const encoded = new URLSearchParams({ [field]: "500", mode: "payment" });
    const ok = await call("POST", "/checkout", encoded.toString(), form);
    expect(ok.statusCode).toBe(201);
    expectError(
      await saveConnection({
        amountLimit: { field: "a[b", maxPerRequest: 1, maxPerDay: 1 },
      }),
      400,
      "BAD_REQUEST",
    );
  });

  it("keeps a daily total, gives back failed calls, and starts again the next day", async () => {
    await saveConnection(POLICY);
    expect((await call("POST", "/charges", { amount: 400 })).statusCode).toBe(
      201,
    );

    outsideStatus = 402;
    expect((await call("POST", "/charges", { amount: 400 })).statusCode).toBe(
      402,
    );
    outsideStatus = 201;

    expect((await call("POST", "/charges", { amount: 400 })).statusCode).toBe(
      201,
    );
    const over = await call("POST", "/charges", { amount: 300 });
    expectError(over, 403, "PROXY_POLICY_DENIED");
    expect(over.json<{ error: { message: string } }>().error.message).toContain(
      "daily limit",
    );
    const day = await usage();
    expect(day.json()).toMatchObject({
      name: "payments",
      day: "2026-11-12",
      amount: { usedToday: 800, maxPerDay: 1000, maxPerRequest: 500 },
    });

    now += 24 * 60 * 60 * 1000;
    vi.setSystemTime(now);
    expect((await call("POST", "/charges", { amount: 300 })).statusCode).toBe(
      201,
    );
  });

  it("limits calls per window (429 with Retry-After)", async () => {
    await saveConnection({ rateLimit: { requests: 2, windowSeconds: 30 } });
    expect((await call("GET", "/charges/a")).statusCode).toBe(201);
    expect((await call("GET", "/charges/b")).statusCode).toBe(201);
    const limited = await call("GET", "/charges/c");
    expectError(limited, 429, "PROXY_RATE_LIMITED");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect(secretReads).toBe(2);
    expect((await usage()).json()).toMatchObject({
      calls: { used: 3, limit: 2, windowSeconds: 30 },
      amount: null,
    });
  });

  it("fails closed: without its counters, a limited connection refuses (503)", async () => {
    await saveConnection(POLICY);
    store.fail = true;
    const refused = await call("POST", "/charges", { amount: 10 });
    expectError(refused, 503, "SERVICE_UNAVAILABLE");
    expect(secretReads).toBe(0);
    expectError(await usage(), 503, "SERVICE_UNAVAILABLE");

    await saveConnection({
      allowedRoutes: [{ method: "GET", path: "/charges/*" }],
    });
    expect((await call("GET", "/charges/x")).statusCode).toBe(201);
  });

  it("refuses bodies too large to check (413), before reading the secret", async () => {
    await saveConnection(POLICY);
    const big = await call("POST", "/charges", {
      amount: 1,
      note: "x".repeat(17 * 1024),
    });
    expectError(big, 413, "PAYLOAD_TOO_LARGE");
    expect(secretReads).toBe(0);
  });
});

describe("policy rules", () => {
  it("matches routes segment by segment, * for one segment, HEAD as GET", () => {
    const policy = {
      allowedRoutes: [
        { method: "GET" as const, path: "/charges/*" },
        { method: "POST" as const, path: "/charges" },
      ],
    };
    expect(routeAllowed(policy, "GET", "/charges/ch_1")).toBe(true);
    expect(routeAllowed(policy, "HEAD", "/charges/ch_1?x=1")).toBe(true);
    expect(routeAllowed(policy, "POST", "/charges/")).toBe(true);
    expect(routeAllowed(policy, "GET", "/charges")).toBe(false);
    expect(routeAllowed(policy, "GET", "/charges/ch_1/refunds")).toBe(false);
    expect(routeAllowed(policy, "DELETE", "/charges/ch_1")).toBe(false);
    expect(routeAllowed({}, "DELETE", "/anything")).toBe(true);
  });

  it("reads only whole, positive amounts from a form body, once", () => {
    const form = (text: string) =>
      amountFrom(
        Buffer.from(text),
        "amount",
        "application/x-www-form-urlencoded",
      );
    expect(form("amount=250&currency=sgd")).toBe(250);
    expect(form("currency=sgd")).toBeUndefined();
    expect(form("amount=250&amount=1")).toBeUndefined();
    expect(form("amount=2.5")).toBeUndefined();
    expect(form("amount=0")).toBeUndefined();
    expect(form(`amount=${2 ** 60}`)).toBeUndefined();
    expect(
      amountFrom(Buffer.from("amount=250"), "amount", "text/plain"),
    ).toBeUndefined();
  });

  it("reads only whole, positive amounts from a JSON object", () => {
    const body = (value: unknown) => Buffer.from(JSON.stringify(value));
    expect(amountFrom(body({ amount: 250 }), "amount")).toBe(250);
    expect(amountFrom(body({ total: 250 }), "amount")).toBeUndefined();
    expect(amountFrom(body({ amount: 0 }), "amount")).toBeUndefined();
    expect(amountFrom(body({ amount: 2 ** 60 }), "amount")).toBeUndefined();
    expect(amountFrom(Buffer.from("{oops"), "amount")).toBeUndefined();
  });

  it("finds duplicate routes and a daily limit below the per-call one", () => {
    expect(
      policyProblem({
        allowedRoutes: [
          { method: "GET", path: "/a" },
          { method: "GET", path: "/a" },
        ],
      }),
    ).toContain("twice");
    expect(
      policyProblem({
        amountLimit: { field: "amount", maxPerRequest: 10, maxPerDay: 5 },
      }),
    ).toContain("maxPerDay");
    expect(policyProblem(POLICY as never)).toBeUndefined();
  });

  it("days are UTC days", () => {
    const late = new Date(Date.UTC(2026, 10, 12, 23, 59, 59));
    expect(utcDay(late)).toEqual({
      day: "2026-11-12",
      endsAtMs: Date.UTC(2026, 10, 13),
    });
  });
});

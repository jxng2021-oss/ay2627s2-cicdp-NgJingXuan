import { randomBytes } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import {
  expectPublicContract,
  secretsContract,
  serviceError,
  startContractService,
} from "./contract-helpers.js";
import {
  captureLogs,
  createTenantWithKey,
  createTestDatabase,
  expectError,
  FakeAudit,
  startFakeStorage,
  startGateway,
} from "./helpers.js";

const KEY_A = "sk_outside_tenant_A_0123456789abcdef";
const KEY_B = "sk_outside_tenant_B_fedcba9876543210";

interface Received {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  bodyBytes: number;
}

let app: FastifyInstance;
let logs: ReturnType<typeof captureLogs>;
let received: Received[];
let secretRequests: { url: string; tenant: string }[];
let secretValues: Map<string, string>;
let sealed: boolean;
let upstreamPort: string;
let tenantA: { tenantId: string; key: string };
let tenantB: { tenantId: string; key: string };
let audit: FakeAudit;

async function startOutsideApi() {
  return startFakeStorage((req, res) => {
    let bodyBytes = 0;
    req.on("data", (chunk: Buffer) => (bodyBytes += chunk.length));
    req.on("end", () => {
      received.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        bodyBytes,
      });
      const path = (req.url ?? "").split("?")[0];
      if (path === "/api/redirect") {
        res.writeHead(302, {
          location: `http://127.0.0.1:${upstreamPort}/api/stolen`,
        });
        return res.end();
      }
      if (path === "/api/error") {
        res.writeHead(500, { "content-type": "application/json" });
        return res.end('{"outside":"broke"}');
      }
      if (path === "/api/slow") {
        setTimeout(() => res.end("late"), 2_000);
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        connection: "keep-alive, x-hop-only",
        "x-hop-only": "1",
        "keep-alive": "timeout=5",
        "set-cookie": "session=outside",
        "x-outside": "yes",
      });
      res.end(JSON.stringify({ ok: true, path, bodyBytes }));
    });
  });
}

beforeEach(async () => {
  received = [];
  secretRequests = [];
  secretValues = new Map();
  sealed = false;
  logs = captureLogs();
  audit = new FakeAudit();

  const outside = await startOutsideApi();
  upstreamPort = new URL(outside).port;
  const secrets = await startContractService(secretsContract, (req) => {
    const tenant = String(req.headers["x-tenant-id"]);
    secretRequests.push({ url: req.url, tenant });
    if (sealed)
      return serviceError(req, 503, "SECRETS_SEALED", {
        "cache-control": "no-store",
      });
    const name = decodeURIComponent(req.url.split("/").pop() ?? "");
    const value = secretValues.get(`${tenant}/${name}`);
    if (value === undefined)
      return serviceError(req, 404, "NOT_FOUND", {
        "cache-control": "no-store",
      });
    return {
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify({ name, version: 1, value }),
    };
  });

  const { db } = await createTestDatabase();
  app = await startGateway({
    db,
    secretsUrl: secrets.url,
    responseTimeoutMs: 300,
    maxUploadBytes: 64 * 1024,
    proxy: { allowedHosts: ["mock.test"], allowPrivateTargets: true },
    resolver: (host) =>
      host === "mock.test"
        ? Promise.resolve([{ address: "127.0.0.1", family: 4 }])
        : Promise.reject(new Error("ENOTFOUND")),
    logger: { level: "info", stream: logs.stream },
    audit,
  });
  tenantA = await createTenantWithKey(app, "A");
  tenantB = await createTenantWithKey(app, "B");
  secretValues.set(`${tenantA.tenantId}/payments-key`, KEY_A);
  await connect(tenantA.key, "payments", { headerName: "X-Api-Key" });
});

async function connect(
  apiKey: string,
  name: string,
  settings: {
    headerName?: string;
    headerPrefix?: string;
    baseUrl?: string;
    secretName?: string;
  } = {},
) {
  const response = await app.inject({
    method: "PUT",
    url: `/v1/proxy-connections/${name}`,
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    payload: {
      baseUrl: `http://mock.test:${upstreamPort}/api`,
      secretName: "payments-key",
      headerName: "X-Api-Key",
      ...settings,
    },
  });
  expect(response.statusCode).toBeLessThan(300);
}

async function proxy(
  path: string,
  options: {
    method?: "GET" | "POST" | "PUT" | "DELETE";
    key?: string;
    headers?: Record<string, string>;
    body?: Buffer;
    contract?: boolean;
  } = {},
): Promise<LightMyRequestResponse> {
  const response = await app.inject({
    method: options.method ?? "GET",
    url: path,
    headers: {
      authorization: `Bearer ${options.key ?? tenantA.key}`,
      ...options.headers,
    },
    payload: options.body,
  });
  if (options.contract !== false) {
    expectPublicContract(
      options.method ?? "GET",
      path.split("?")[0]!,
      response,
    );
  }
  return response;
}

describe("secret injection", () => {
  it("adds the key for the outside API, and never returns or logs it", async () => {
    const response = await proxy(
      "/v1/proxy/payments/charges/ch_1?expand=true",
      {
        headers: { "x-custom": "kept", accept: "application/json" },
      },
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      path: "/api/charges/ch_1",
    });
    const [sent] = received;
    expect(sent?.url).toBe("/api/charges/ch_1?expand=true");
    expect(sent?.headers["x-api-key"]).toBe(KEY_A);
    expect(sent?.headers["x-custom"]).toBe("kept");
    expect(sent?.headers.host).toBe(`mock.test:${upstreamPort}`);
    expect(response.body).not.toContain(KEY_A);
    expect(JSON.stringify(response.headers)).not.toContain(KEY_A);
    expect(logs.text()).toContain("request completed");
    expect(logs.text()).not.toContain(KEY_A);
  });

  it("uses a header prefix such as Bearer, in place of the client's own Authorization", async () => {
    await connect(tenantA.key, "bearer", {
      headerName: "Authorization",
      headerPrefix: "Bearer ",
    });

    await proxy("/v1/proxy/bearer/x");

    expect(received[0]?.headers.authorization).toBe(`Bearer ${KEY_A}`);
    expect(JSON.stringify(received[0]?.headers)).not.toContain(tenantA.key);
  });

  it("never forwards the client's credentials, tenant header, a competing key header or hop-by-hop headers", async () => {
    await proxy("/v1/proxy/payments/x", {
      headers: {
        cookie: "session=client",
        "x-tenant-id": tenantB.tenantId,
        "X-API-KEY": "client-tries-its-own-key",
        connection: "x-client-hop",
        "x-client-hop": "1",
        "proxy-authorization": "Basic abc",
        te: "trailers",
        upgrade: "websocket",
      },
    });

    const headers = received[0]?.headers ?? {};
    expect(headers.authorization).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
    expect(headers["x-tenant-id"]).toBeUndefined();
    expect(headers["x-api-key"]).toBe(KEY_A);
    expect(headers["x-client-hop"]).toBeUndefined();
    expect(headers["proxy-authorization"]).toBeUndefined();
    expect(headers.upgrade).toBeUndefined();
    expect(JSON.stringify(headers)).not.toContain(tenantA.key);
  });

  it("returns the answer without hop-by-hop headers or cookies", async () => {
    const response = await proxy("/v1/proxy/payments/x");

    expect(response.headers["x-outside"]).toBe("yes");
    expect(response.headers["x-hop-only"]).toBeUndefined();
    expect(response.headers["keep-alive"]).toBeUndefined();
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("fetches the secret for every request: a rotated secret is used on the next one", async () => {
    await proxy("/v1/proxy/payments/x");
    secretValues.set(`${tenantA.tenantId}/payments-key`, "rotated-value");
    await proxy("/v1/proxy/payments/x");

    expect(received.map((r) => r.headers["x-api-key"])).toEqual([
      KEY_A,
      "rotated-value",
    ]);
    expect(secretRequests).toHaveLength(2);
    expect(secretRequests[0]?.url).toBe("/internal/secrets/payments-key");
  });

  it("streams request bodies, and refuses ones over the size limit", async () => {
    const ok = await proxy("/v1/proxy/payments/upload", {
      method: "POST",
      body: randomBytes(40 * 1024),
    });
    const tooLarge = await proxy("/v1/proxy/payments/upload", {
      method: "POST",
      body: randomBytes(65 * 1024),
    });

    expect(ok.json()).toMatchObject({ bodyBytes: 40 * 1024 });
    expectError(tooLarge, 413, "PAYLOAD_TOO_LARGE");
    expect(received).toHaveLength(1);
  });

  it("passes on every method", async () => {
    for (const method of ["GET", "POST", "PUT", "DELETE"] as const) {
      await proxy("/v1/proxy/payments/x", {
        method,
        body: method === "GET" ? undefined : Buffer.from("x"),
      });
    }

    expect(received.map((r) => r.method)).toEqual([
      "GET",
      "POST",
      "PUT",
      "DELETE",
    ]);
  });
});

describe("tenants", () => {
  it("tenant B can't use tenant A's connection", async () => {
    const response = await proxy("/v1/proxy/payments/x", { key: tenantB.key });

    expectError(response, 404, "NOT_FOUND");
    expect(received).toEqual([]);
    expect(secretRequests).toEqual([]);
  });

  it("tenant B's connection of the same name uses tenant B's secret, never A's", async () => {
    await connect(tenantB.key, "payments");
    secretValues.set(`${tenantB.tenantId}/payments-key`, KEY_B);

    await proxy("/v1/proxy/payments/x", { key: tenantB.key });

    expect(received[0]?.headers["x-api-key"]).toBe(KEY_B);
    expect(secretRequests[0]?.tenant).toBe(tenantB.tenantId);
  });

  it("tenant B without the secret gets 409, not tenant A's", async () => {
    await connect(tenantB.key, "payments");

    const response = await proxy("/v1/proxy/payments/x", { key: tenantB.key });

    expectError(response, 409, "PROXY_SECRET_MISSING");
    expect(received).toEqual([]);
  });
});

describe("redirects and errors", () => {
  it("doesn't follow a redirect, so the key isn't sent anywhere else", async () => {
    const response = await proxy("/v1/proxy/payments/redirect");

    expectError(response, 502, "UPSTREAM_REDIRECT");
    expect(received.map((r) => r.url)).toEqual(["/api/redirect"]);
    expect(response.headers.location).toBeUndefined();
  });

  it("503 SECRETS_SEALED while the secrets service is sealed, without calling the outside API", async () => {
    sealed = true;

    const response = await proxy("/v1/proxy/payments/x");

    expectError(response, 503, "SECRETS_SEALED");
    expect(received).toEqual([]);
  });

  it("409 PROXY_SECRET_MISSING when the secret doesn't exist", async () => {
    secretValues.clear();

    expectError(
      await proxy("/v1/proxy/payments/x"),
      409,
      "PROXY_SECRET_MISSING",
    );
  });

  it("passes the outside API's own error responses through", async () => {
    const response = await proxy("/v1/proxy/payments/error", {
      contract: false,
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ outside: "broke" });
  });

  it("502 when the outside API is down, 504 when it's too slow", async () => {
    await connect(tenantA.key, "down", { baseUrl: "http://mock.test:1/api" });

    expectError(
      await proxy("/v1/proxy/down/x"),
      502,
      "UPSTREAM_UNAVAILABLE",
      "The outside API is unavailable",
    );
    expectError(
      await proxy("/v1/proxy/payments/slow"),
      504,
      "UPSTREAM_TIMEOUT",
    );
  });

  it("502 when the secrets service is down", async () => {
    const { db } = await createTestDatabase();
    const broken = await startGateway({
      db,
      secretsUrl: "http://127.0.0.1:1",
      proxy: { allowedHosts: ["mock.test"], allowPrivateTargets: true },
      resolver: () => Promise.resolve([{ address: "127.0.0.1", family: 4 }]),
    });
    const { key } = await createTenantWithKey(broken);
    await broken.inject({
      method: "PUT",
      url: "/v1/proxy-connections/p",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      payload: {
        baseUrl: `http://mock.test:${upstreamPort}`,
        secretName: "s",
        headerName: "X-Key",
      },
    });

    const response = await broken.inject({
      method: "GET",
      url: "/v1/proxy/p/x",
      headers: { authorization: `Bearer ${key}` },
    });

    expectError(
      response,
      502,
      "UPSTREAM_UNAVAILABLE",
      "Secrets service is unavailable",
    );
  });

  it("404 for a connection that doesn't exist, 400 for a bad name, 401 without a key", async () => {
    expectError(await proxy("/v1/proxy/nope/x"), 404, "NOT_FOUND");
    expectError(await proxy("/v1/proxy/-bad/x"), 400, "BAD_REQUEST");
    const noKey = await app.inject({
      method: "GET",
      url: "/v1/proxy/payments/x",
    });
    expectError(noKey, 401, "UNAUTHORIZED");
    expect(received).toEqual([]);
  });
});

describe("SSRF", () => {
  it.each([
    "/v1/proxy/payments/../admin",
    "/v1/proxy/payments/%2e%2e/admin",
    "/v1/proxy/payments/..%2f..%2fadmin",
    "/v1/proxy/payments/x%2F..%2F..%2Fadmin",
    "/v1/proxy/payments/%5c..%5cadmin",
  ])("refuses the path trick %s, without calling anything", async (path) => {
    const response = await proxy(path);
    expect([400, 404]).toContain(response.statusCode);
    expect(received).toEqual([]);
    expect(secretRequests).toEqual([]);
  });

  it("paths that look like other hosts still go to the connection's host and base path", async () => {
    await proxy("/v1/proxy/payments//evil.example/x");
    await proxy("/v1/proxy/payments/http://evil.example/");
    await proxy("/v1/proxy/payments/@evil.example");

    expect(
      received.map((r) => [r.headers.host, r.url.startsWith("/api/")]),
    ).toEqual([
      [`mock.test:${upstreamPort}`, true],
      [`mock.test:${upstreamPort}`, true],
      [`mock.test:${upstreamPort}`, true],
    ]);
  });

  it("refuses a host that resolves to a private address (without the local-only setting)", async () => {
    const { db } = await createTestDatabase();
    const strict = await startGateway({
      db,
      proxy: { allowedHosts: ["api.example.com"], allowPrivateTargets: false },
      resolver: () => Promise.resolve([{ address: "10.0.0.7", family: 4 }]),
    });
    const { key } = await createTenantWithKey(strict);
    await strict.inject({
      method: "PUT",
      url: "/v1/proxy-connections/p",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      payload: {
        baseUrl: "https://api.example.com",
        secretName: "s",
        headerName: "X-Key",
      },
    });

    const response = await strict.inject({
      method: "GET",
      url: "/v1/proxy/p/x",
      headers: { authorization: `Bearer ${key}` },
    });

    expectError(response, 403, "PROXY_TARGET_BLOCKED");
    expect(
      response.json<{ error: { message: string } }>().error.message,
    ).toMatch(/private or loopback/);
  });

  it("refuses a saved connection whose host was removed from the allowlist since", async () => {
    const { db } = await createTestDatabase();
    const before = await startGateway({
      db,
      proxy: { allowedHosts: ["mock.test"], allowPrivateTargets: true },
    });
    const { key } = await createTenantWithKey(before);
    await before.inject({
      method: "PUT",
      url: "/v1/proxy-connections/p",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      payload: {
        baseUrl: `http://mock.test:${upstreamPort}`,
        secretName: "s",
        headerName: "X-Key",
      },
    });
    const after = await startGateway({
      db,
      proxy: { allowedHosts: [], allowPrivateTargets: true },
    });

    const response = await after.inject({
      method: "GET",
      url: "/v1/proxy/p/x",
      headers: { authorization: `Bearer ${key}` },
    });

    expectError(response, 403, "PROXY_TARGET_BLOCKED");
    expect(received).toEqual([]);
  });
});

describe("the internal secret route stays internal", () => {
  it.each([
    "/v1/internal/secrets/payments-key",
    "/internal/secrets/payments-key",
    "/v1/secrets/..%2finternal%2fsecrets%2fpayments-key",
    "/v1/secrets/payments-key/../../internal/secrets/payments-key",
  ])("%s can't reach it through the gateway", async (url) => {
    const response = await app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${tenantA.key}` },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.body).not.toContain(KEY_A);
    expect(secretRequests.filter((r) => r.url.startsWith("/internal"))).toEqual(
      [],
    );
  });
});

describe("proxy audit events (best effort)", () => {
  async function proxyEvents() {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return audit.events
      .filter((e) => e.action.startsWith("proxy_connection."))
      .map((e) => [e.action, e.resourceId, e.outcome]);
  }

  it("records connections created, updated, used and deleted, never the secret", async () => {
    await connect(tenantA.key, "payments", { headerPrefix: "Bearer " });
    const used = await proxy("/v1/proxy/payments/orders/1");
    await app.inject({
      method: "DELETE",
      url: "/v1/proxy-connections/payments",
      headers: { authorization: `Bearer ${tenantA.key}` },
    });

    expect(await proxyEvents()).toEqual([
      ["proxy_connection.created", "payments", "success"],
      ["proxy_connection.updated", "payments", "success"],
      ["proxy_connection.used", "payments", "success"],
      ["proxy_connection.deleted", "payments", "success"],
    ]);
    const usedEvent = audit.events.find(
      (e) => e.action === "proxy_connection.used",
    );
    expect(usedEvent).toMatchObject({
      actorType: "api_key",
      tenantId: tenantA.tenantId,
      requestId: used.headers["x-request-id"],
    });
    expect(JSON.stringify(audit.events)).not.toContain(KEY_A);
  });

  it("an outside API's own error is still a successful use; a blocked path is denied; a missing secret is a failure", async () => {
    await proxy("/v1/proxy/payments/error", { contract: false });
    await proxy("/v1/proxy/payments/..%2f..%2fadmin");
    secretValues.clear();
    await proxy("/v1/proxy/payments/orders/1");

    expect((await proxyEvents()).slice(1)).toEqual([
      ["proxy_connection.used", "payments", "success"],
      ["proxy_connection.used", "payments", "denied"],
      ["proxy_connection.used", "payments", "failure"],
    ]);
  });

  it("the proxy keeps working while the audit log is down, and the loss is logged", async () => {
    audit.down = true;

    const response = await proxy("/v1/proxy/payments/orders/1", {
      contract: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(response.statusCode).toBe(200);
    expect(logs.text()).toContain("AUDIT EVENT LOST");
  });
});

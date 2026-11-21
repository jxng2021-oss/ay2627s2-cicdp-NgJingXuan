import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import {
  expectPublicContract,
  secretsContract,
  serviceError,
  startContractService,
  type ReceivedRequest,
  type ServiceReply,
} from "./contract-helpers.js";
import {
  captureLogs,
  createTenantWithKey,
  createTestDatabase,
  expectError,
  startFakeStorage,
  startGateway,
} from "./helpers.js";

const NO_STORE = { "cache-control": "no-store" };
const MAX_SECRET_BYTES = 1024;

function fakeSecretsService() {
  const tenants = new Map<string, Map<string, string[]>>();
  const json = (status: number, body: unknown): ServiceReply => ({
    status,
    contentType: "application/json; charset=utf-8",
    headers: NO_STORE,
    body: JSON.stringify(body),
  });
  const notFound = (req: ReceivedRequest) =>
    serviceError(req, 404, "NOT_FOUND", NO_STORE);
  const createdAt = "2026-11-04T09:30:00.000Z";

  return (req: ReceivedRequest): ServiceReply => {
    const tenant = String(req.headers["x-tenant-id"]);
    const secrets = tenants.get(tenant) ?? new Map<string, string[]>();
    tenants.set(tenant, secrets);
    const url = new URL(req.url, "http://secrets");
    const [, , rawName, action] = url.pathname.split("/");
    const name =
      rawName === undefined ? undefined : decodeURIComponent(rawName);
    const versions = name === undefined ? undefined : secrets.get(name);
    const value = () =>
      (JSON.parse(req.body.toString()) as { value: string }).value;

    if (name === undefined) {
      return json(200, {
        secrets: [...secrets.keys()].sort().map((n) => ({
          name: n,
          latestVersion: secrets.get(n)?.length ?? 0,
          createdAt,
          updatedAt: createdAt,
        })),
        nextCursor: null,
      });
    }
    if (req.method === "PUT") {
      const list = versions ?? [];
      list.push(value());
      secrets.set(name, list);
      return json(list.length === 1 ? 201 : 200, {
        name,
        version: list.length,
        createdAt,
      });
    }
    if (!versions) return notFound(req);
    if (req.method === "POST" && action === "rotate") {
      versions.push(value());
      return json(200, { name, version: versions.length, createdAt });
    }
    if (req.method === "DELETE") {
      secrets.delete(name);
      return { status: 204, headers: NO_STORE };
    }
    if (action === "versions") {
      return json(200, {
        name,
        versions: versions
          .map((_, i) => ({ version: i + 1, createdAt }))
          .reverse(),
        nextCursor: null,
      });
    }
    const version = Number(url.searchParams.get("version") ?? versions.length);
    const found = versions[version - 1];
    if (found === undefined) return notFound(req);
    return json(200, { name, version, createdAt });
  };
}

let app: FastifyInstance;
let service: Awaited<ReturnType<typeof startContractService>>;
let tenant: { tenantId: string; key: string };
let auth: { authorization: string };

async function setup(
  reply: (req: ReceivedRequest) => ServiceReply = fakeSecretsService(),
) {
  service = await startContractService(secretsContract, reply);
  const { db } = await createTestDatabase();
  app = await startGateway({ db, secretsUrl: service.url });
  tenant = await createTenantWithKey(app);
  auth = { authorization: `Bearer ${tenant.key}` };
}

beforeEach(async () => {
  await setup();
});

async function call(
  method: "GET" | "PUT" | "POST" | "DELETE",
  url: string,
  options: {
    body?: unknown;
    headers?: Record<string, string>;
    raw?: string;
  } = {},
): Promise<LightMyRequestResponse> {
  const response = await app.inject({
    method,
    url,
    headers: {
      ...auth,
      ...(options.body !== undefined
        ? { "content-type": "application/json" }
        : {}),
      ...options.headers,
    },
    payload:
      options.raw ??
      (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
  expectPublicContract(method, url, response);
  return response;
}

describe("the gateway uses the secrets service as the internal contract says", () => {
  it("every route: the right method, path, query and body, with the verified tenant", async () => {
    const responses = [
      await call("PUT", "/v1/secrets/db.password", { body: { value: "one" } }),
      await call("PUT", "/v1/secrets/db.password", { body: { value: "two" } }),
      await call("GET", "/v1/secrets/db.password"),
      await call("GET", "/v1/secrets/db.password?version=1"),
      await call("GET", "/v1/secrets/db.password/versions?limit=5&cursor=9"),
      await call("POST", "/v1/secrets/db.password/rotate", {
        body: { value: "three" },
      }),
      await call("GET", "/v1/secrets?limit=10&cursor=a"),
      await call("DELETE", "/v1/secrets/db.password"),
    ];

    expect(service.problems).toEqual([]);
    expect(responses.map((r) => r.statusCode)).toEqual([
      201, 200, 200, 200, 200, 200, 200, 204,
    ]);
    expect(service.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      "PUT /secrets/db.password",
      "PUT /secrets/db.password",
      "GET /secrets/db.password",
      "GET /secrets/db.password?version=1",
      "GET /secrets/db.password/versions?limit=5&cursor=9",
      "POST /secrets/db.password/rotate",
      "GET /secrets?limit=10&cursor=a",
      "DELETE /secrets/db.password",
    ]);
    expect(responses[2]?.json()).toMatchObject({ version: 2 });
    expect(responses[3]?.json()).toMatchObject({ version: 1 });
    expect(responses[2]?.json()).not.toHaveProperty("value");
    for (const [i, request] of service.requests.entries()) {
      expect(request.headers["x-tenant-id"]).toBe(tenant.tenantId);
      expect(request.headers["x-request-id"]).toBe(
        responses[i]?.headers["x-request-id"],
      );
    }
  });

  it("forwards only the validated value: no client headers, no spoofed tenant, no extra fields", async () => {
    await call("PUT", "/v1/secrets/x", {
      body: { value: "v" },
      headers: {
        "x-tenant-id": "11111111-1111-4111-8111-111111111111",
        cookie: "session=abc",
        "x-forwarded-for": "203.0.113.9",
      },
    });

    const [sent] = service.requests;
    expect(sent?.headers["x-tenant-id"]).toBe(tenant.tenantId);
    expect(sent?.headers.authorization).toBeUndefined();
    expect(sent?.headers.cookie).toBeUndefined();
    expect(sent?.headers["x-forwarded-for"]).toBeUndefined();
    expect(sent?.body.toString()).toBe('{"value":"v"}');
  });

  it("marks every secrets response Cache-Control: no-store, including errors", async () => {
    await call("PUT", "/v1/secrets/x", { body: { value: "v" } });

    const responses = [
      await call("GET", "/v1/secrets/x"),
      await call("GET", "/v1/secrets"),
      await call("GET", "/v1/secrets/missing"),
      await call("GET", "/v1/secrets/-bad-name"),
    ];

    for (const response of responses) {
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  });

  it("another tenant's key gets the same 404 as a missing secret, on every route", async () => {
    await call("PUT", "/v1/secrets/private", {
      body: { value: "tenant A only" },
    });
    const other = await createTenantWithKey(app, "Other");
    auth = { authorization: `Bearer ${other.key}` };

    const responses = [
      await call("GET", "/v1/secrets/private"),
      await call("GET", "/v1/secrets/private?version=1"),
      await call("GET", "/v1/secrets/private/versions"),
      await call("POST", "/v1/secrets/private/rotate", {
        body: { value: "x" },
      }),
      await call("DELETE", "/v1/secrets/private"),
    ];
    const list = await call("GET", "/v1/secrets");

    for (const response of responses) {
      expectError(response, 404, "NOT_FOUND");
      expect(response.body).not.toContain("tenant A only");
    }
    expect(list.json()).toEqual({ secrets: [], nextCursor: null });
    expect(service.problems).toEqual([]);
  });

  it.each([
    ["an invalid name", "GET", "/v1/secrets/-starts-with-dash", undefined],
    ["a name with a slash", "GET", "/v1/secrets/a%2Fb", undefined],
    [
      "a 129-character name",
      "GET",
      `/v1/secrets/${"x".repeat(129)}`,
      undefined,
    ],
    ["version 0", "GET", "/v1/secrets/x?version=0", undefined],
    ["a non-numeric version", "GET", "/v1/secrets/x?version=latest", undefined],
    ["limit over 100", "GET", "/v1/secrets?limit=101", undefined],
    ["a bad cursor", "GET", "/v1/secrets/x/versions?cursor=abc", undefined],
    ["a number value", "PUT", "/v1/secrets/x", { value: 42 }],
    ["an array value", "PUT", "/v1/secrets/x", { value: ["v"] }],
    [
      "an extra field",
      "PUT",
      "/v1/secrets/x",
      { value: "v", tenantId: "someone-else" },
    ],
    ["no value", "POST", "/v1/secrets/x/rotate", {}],
  ] as const)(
    "refuses %s with 400, without calling the secrets service",
    async (_case, method, url, body) => {
      const response = await call(
        method,
        url,
        body === undefined ? {} : { body },
      );

      expectError(response, 400, "BAD_REQUEST");
      expect(service.requests).toEqual([]);
    },
  );

  it("refuses a value over MAX_SECRET_BYTES (413) and non-JSON bodies (415) itself", async () => {
    const tooLarge = await call("PUT", "/v1/secrets/x", {
      body: { value: "é".repeat(MAX_SECRET_BYTES / 2 + 1) },
    });
    const notJson = await call("PUT", "/v1/secrets/x", {
      raw: "value",
      headers: { "content-type": "text/plain" },
    });

    expectError(tooLarge, 413, "PAYLOAD_TOO_LARGE");
    expectError(notJson, 415, "UNSUPPORTED_MEDIA_TYPE");
    expect(service.requests).toEqual([]);
  });

  it("needs a valid API key (401), and never calls the secrets service without one", async () => {
    auth = { authorization: "Bearer wrong" };

    const responses = [
      await call("GET", "/v1/secrets"),
      await call("PUT", "/v1/secrets/x", { body: { value: "v" } }),
    ];

    for (const response of responses)
      expectError(response, 401, "UNAUTHORIZED");
    expect(service.requests).toEqual([]);
  });
});

describe("secrets service errors reach the client within the public contract", () => {
  it.each([
    ["GET", "/v1/secrets/x", 500, "INTERNAL_ERROR"],
    ["GET", "/v1/secrets", 503, "SERVICE_UNAVAILABLE"],
    ["GET", "/v1/secrets/x", 503, "SECRETS_SEALED"],
    ["PUT", "/v1/secrets/x", 503, "SECRETS_SEALED"],
    ["PUT", "/v1/secrets/x", 413, "PAYLOAD_TOO_LARGE"],
    ["POST", "/v1/secrets/x/rotate", 404, "NOT_FOUND"],
  ] as const)("%s %s -> %i", async (method, url, status, code) => {
    await setup((req) => serviceError(req, status, code, NO_STORE));

    const response = await call(
      method,
      url,
      method === "GET" ? {} : { body: { value: "v" } },
    );

    expectError(response, status, code);
    expect(service.problems).toEqual([]);
  });

  it("502 when the secrets service is down, 504 when it's too slow", async () => {
    const { db } = await createTestDatabase();
    const slowUrl = await startFakeStorage((_req, res) => {
      setTimeout(() => res.end(), 2_000);
    });
    const down = await startGateway({ db, secretsUrl: "http://127.0.0.1:1" });
    const slow = await startGateway({
      db,
      secretsUrl: slowUrl,
      responseTimeoutMs: 100,
    });
    const { key } = await createTenantWithKey(down);
    const headers = { authorization: `Bearer ${key}` };

    const unavailable = await down.inject({
      method: "GET",
      url: "/v1/secrets/x",
      headers,
    });
    const timedOut = await slow.inject({
      method: "GET",
      url: "/v1/secrets/x",
      headers,
    });

    expectError(
      unavailable,
      502,
      "UPSTREAM_UNAVAILABLE",
      "Secrets service is unavailable",
    );
    expectError(
      timedOut,
      504,
      "UPSTREAM_TIMEOUT",
      "Secrets service did not respond in time",
    );
    expectPublicContract("GET", "/v1/secrets/x", unavailable);
    expectPublicContract("GET", "/v1/secrets/x", timedOut);
  });
});

describe("secret values stay out of the gateway's logs", () => {
  it("never logs values or request bodies", async () => {
    const logs = captureLogs();
    service = await startContractService(secretsContract, fakeSecretsService());
    const { db } = await createTestDatabase();
    app = await startGateway({
      db,
      secretsUrl: service.url,
      logger: { level: "info", stream: logs.stream },
    });
    tenant = await createTenantWithKey(app);
    auth = { authorization: `Bearer ${tenant.key}` };
    const VALUE = "gateway-log-check-value-8f2a";

    await call("PUT", "/v1/secrets/logged", { body: { value: VALUE } });
    await call("GET", "/v1/secrets/logged");
    await call("POST", "/v1/secrets/logged/rotate", { body: { value: VALUE } });
    await call("PUT", "/v1/secrets/x", { raw: `{"value":"${VALUE}` });

    expect(logs.text()).toContain("request completed");
    expect(logs.text()).not.toContain(VALUE);
  });
});

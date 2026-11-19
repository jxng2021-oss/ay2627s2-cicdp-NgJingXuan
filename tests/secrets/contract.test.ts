import { randomUUID } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { Contract, loadSpec } from "../../api/validate.js";
import type { Database } from "../../services/secrets/src/db/client.js";
import {
  createTestDatabase,
  MAX_SECRET_BYTES,
  newTenant,
  startSecrets,
  testKeyProvider,
} from "./helpers.js";

const contract = new Contract(loadSpec("api/internal/secrets.openapi.json"));

let db: Database;
let app: FastifyInstance;
let tenant: string;

beforeEach(async () => {
  ({ db } = await createTestDatabase());
  app = await startSecrets({ db });
  tenant = newTenant();
});

async function call(
  method: "GET" | "PUT" | "POST" | "DELETE",
  url: string,
  options: {
    body?: unknown;
    tenantId?: string | null;
    remoteAddress?: string;
    contentType?: string;
    raw?: string;
    instance?: FastifyInstance;
  } = {},
): Promise<LightMyRequestResponse> {
  const tenantId = options.tenantId === undefined ? tenant : options.tenantId;
  const headers: Record<string, string> = { "x-request-id": randomUUID() };
  if (tenantId !== null) headers["x-tenant-id"] = tenantId;
  const payload =
    options.raw ??
    (options.body === undefined ? undefined : JSON.stringify(options.body));
  if (payload !== undefined) {
    headers["content-type"] = options.contentType ?? "application/json";
  }

  const response = await (options.instance ?? app).inject({
    method,
    url,
    headers,
    payload,
    remoteAddress: options.remoteAddress,
  });
  expect(
    contract.checkResponse(method, url, {
      statusCode: response.statusCode,
      headers: response.headers,
      body: response.body,
    }),
  ).toEqual([]);
  return response;
}

describe("the secrets service meets the internal contract", () => {
  it("GET /health and /ready", async () => {
    expect((await call("GET", "/health")).statusCode).toBe(200);
    expect((await call("GET", "/ready")).statusCode).toBe(200);
  });

  it("/ready when Postgres is down (503)", async () => {
    const down = await startSecrets({
      db: {
        execute: () => Promise.reject(new Error("down")),
      } as unknown as Database,
    });

    expect((await call("GET", "/ready", { instance: down })).statusCode).toBe(
      503,
    );
  });

  it("PUT (201, 200), GET (200), versions (200), rotate (200), list (200), DELETE (204)", async () => {
    const statuses = [
      (await call("PUT", "/secrets/db.password", { body: { value: "a" } }))
        .statusCode,
      (await call("PUT", "/secrets/db.password", { body: { value: "b" } }))
        .statusCode,
      (await call("GET", "/secrets/db.password")).statusCode,
      (await call("GET", "/secrets/db.password?version=1")).statusCode,
      (await call("GET", "/secrets/db.password/versions?limit=1")).statusCode,
      (await call("GET", "/secrets/db.password/versions?limit=1&cursor=2"))
        .statusCode,
      (
        await call("POST", "/secrets/db.password/rotate", {
          body: { value: "c" },
        })
      ).statusCode,
      (await call("GET", "/secrets?limit=10")).statusCode,
      (await call("GET", "/secrets?cursor=a")).statusCode,
      (await call("DELETE", "/secrets/db.password")).statusCode,
    ];

    expect(statuses).toEqual([
      201, 200, 200, 200, 200, 200, 200, 200, 200, 204,
    ]);
  });

  it("404 for a missing secret, a missing version and another tenant's secret, on every route", async () => {
    await call("PUT", "/secrets/mine", { body: { value: "v" } });
    const other = { tenantId: newTenant() };

    const statuses = [
      (await call("GET", "/secrets/nope")).statusCode,
      (await call("GET", "/secrets/mine?version=9")).statusCode,
      (await call("GET", "/secrets/mine", other)).statusCode,
      (await call("GET", "/secrets/mine/versions", other)).statusCode,
      (
        await call("POST", "/secrets/mine/rotate", {
          ...other,
          body: { value: "x" },
        })
      ).statusCode,
      (await call("DELETE", "/secrets/mine", other)).statusCode,
    ];

    expect(statuses).toEqual([404, 404, 404, 404, 404, 404]);
  });

  it("400 for a bad name, query, body or X-Tenant-Id", async () => {
    const statuses = [
      (await call("PUT", "/secrets/-bad", { body: { value: "v" } })).statusCode,
      (await call("GET", "/secrets/x?version=0")).statusCode,
      (await call("GET", "/secrets?limit=500")).statusCode,
      (await call("PUT", "/secrets/x", { body: { value: 1 } })).statusCode,
      (await call("PUT", "/secrets/x", { raw: "{not json" })).statusCode,
      (await call("GET", "/secrets", { tenantId: null })).statusCode,
      (await call("GET", "/secrets", { tenantId: "tenant-a" })).statusCode,
    ];

    expect(statuses.every((s) => s === 400)).toBe(true);
  });

  it("403 from outside the internal network", async () => {
    const response = await call("GET", "/secrets", {
      remoteAddress: "203.0.113.10",
    });

    expect(response.statusCode).toBe(403);
  });

  it("413 for a value over MAX_SECRET_BYTES, 415 for a non-JSON body", async () => {
    const tooLarge = await call("PUT", "/secrets/x", {
      body: { value: "x".repeat(MAX_SECRET_BYTES + 1) },
    });
    const notJson = await call("PUT", "/secrets/x", {
      raw: "<value/>",
      contentType: "application/xml",
    });

    expect([tooLarge.statusCode, notJson.statusCode]).toEqual([413, 415]);
  });

  it("500 (generic) for data that can't be decrypted", async () => {
    await call("PUT", "/secrets/x", { body: { value: "v" } });
    const wrongKey = await startSecrets({
      db,
      keyProvider: testKeyProvider(3),
    });

    expect(
      (await call("GET", "/internal/secrets/x", { instance: wrongKey }))
        .statusCode,
    ).toBe(500);
  });
});

describe("the internal contract fits the public API", () => {
  it("only uses error codes that the public API also documents", () => {
    const internalCodes = errorCodes(
      loadSpec("api/internal/secrets.openapi.json"),
    );
    const publicCodes = errorCodes(loadSpec("api/openapi.v1.json"));

    expect(internalCodes.length).toBeGreaterThan(0);
    expect(internalCodes.filter((code) => !publicCodes.includes(code))).toEqual(
      [],
    );
  });
});

function errorCodes(spec: object): string[] {
  const codes = new Set<string>();
  JSON.stringify(spec, (key, value: unknown) => {
    if (
      key === "code" &&
      typeof value === "object" &&
      value !== null &&
      "enum" in value
    ) {
      for (const code of (value as { enum: string[] }).enum) codes.add(code);
    }
    return value;
  });
  return [...codes];
}

import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Database } from "../../services/gateway/src/db/client.js";
import { tenants } from "../../services/gateway/src/db/schema.js";
import { MemoryRateLimitStore } from "../../services/gateway/src/rate-limit.js";
import {
  expectPublicContract,
  publicContract,
  startContractStorage,
  storageError,
} from "./contract-helpers.js";
import {
  createTenantWithKey,
  createTestDatabase,
  startFakeStorage,
  startGateway,
} from "./helpers.js";

const FILE_ID = "3f2c9b1e-6a4d-4c8e-9f1a-2b3c4d5e6f70";
const UPLOAD = "/v1/storage/files";
const DOWNLOAD = `/v1/storage/files/${FILE_ID}`;

async function setup(
  options: {
    storageUrl?: string;
    responseTimeoutMs?: number;
    rateLimits?: object;
  } = {},
) {
  const storage = await startContractStorage((req, body) =>
    req.method === "POST"
      ? {
          status: 201,
          contentType: "application/json; charset=utf-8",
          body: JSON.stringify({
            id: FILE_ID,
            size: body.length,
            name: null,
            contentType: "application/octet-stream",
            createdAt: "2026-11-05T09:30:00.000Z",
          }),
        }
      : req.url === `/files/${FILE_ID}`
        ? {
            status: 200,
            contentType: "application/octet-stream",
            headers: {
              "content-disposition": 'attachment; filename="f"',
              "x-content-type-options": "nosniff",
            },
            body: Buffer.from("file"),
          }
        : storageError(req, 404, "NOT_FOUND"),
  );
  const { db } = await createTestDatabase();
  const store = new MemoryRateLimitStore();
  const tenant = await createTenantWithKey(await startGateway({ db }));
  const app = await startGateway({
    db,
    storageUrl: options.storageUrl ?? storage.url,
    ...(options.responseTimeoutMs
      ? { responseTimeoutMs: options.responseTimeoutMs }
      : {}),
    rateLimitStore: store,
    maxUploadBytes: 1024,
    rateLimits: options.rateLimits,
  });
  const auth = { authorization: `Bearer ${tenant.key}` };
  return { app, db, store, tenant, auth, storage };
}

describe("public API responses match api/openapi.v1.json", () => {
  it("documents only the public routes", () => {
    expect(() => publicContract.operation("POST", UPLOAD)).not.toThrow();
    expect(() => publicContract.operation("GET", DOWNLOAD)).not.toThrow();
    expect(() => publicContract.operation("POST", "/admin/tenants")).toThrow();
    expect(() => publicContract.operation("POST", "/storage/files")).toThrow();
  });

  it("201 upload, 200 download, 404 missing file", async () => {
    const { app, auth, storage } = await setup();

    const uploaded = await app.inject({
      method: "POST",
      url: UPLOAD,
      headers: { ...auth, "content-type": "application/octet-stream" },
      payload: randomBytes(100),
    });
    const downloaded = await app.inject({
      method: "GET",
      url: DOWNLOAD,
      headers: auth,
    });
    const missingUrl = "/v1/storage/files/00000000-0000-4000-8000-000000000000";
    const missing = await app.inject({
      method: "GET",
      url: missingUrl,
      headers: auth,
    });

    expect([
      uploaded.statusCode,
      downloaded.statusCode,
      missing.statusCode,
    ]).toEqual([201, 200, 404]);
    expectPublicContract("POST", UPLOAD, uploaded);
    expectPublicContract("GET", DOWNLOAD, downloaded);
    expectPublicContract("GET", missingUrl, missing);
    expect(storage.problems).toEqual([]);
  });

  it("400 for a malformed file ID", async () => {
    const { app, auth } = await setup();
    const url = "/v1/storage/files/not-a-valid-id";

    const response = await app.inject({ method: "GET", url, headers: auth });

    expect(response.statusCode).toBe(400);
    expectPublicContract("GET", url, response);
  });

  it("401 without a valid key, on both routes", async () => {
    const { app } = await setup();

    const responses = await Promise.all([
      app.inject({
        method: "POST",
        url: UPLOAD,
        headers: { authorization: "Bearer wrong" },
        payload: "x",
      }),
      app.inject({ method: "GET", url: DOWNLOAD }),
    ]);

    expect(responses.map((r) => r.statusCode)).toEqual([401, 401]);
    expectPublicContract("POST", UPLOAD, responses[0]);
    expectPublicContract("GET", DOWNLOAD, responses[1]);
  });

  it("403 for a suspended tenant", async () => {
    const { app, db, tenant, auth } = await setup();
    await db
      .update(tenants)
      .set({ status: "suspended" })
      .where(eq(tenants.id, tenant.tenantId));

    const response = await app.inject({
      method: "GET",
      url: DOWNLOAD,
      headers: auth,
    });

    expect(response.statusCode).toBe(403);
    expectPublicContract("GET", DOWNLOAD, response);
  });

  it("413 for an upload over the limit", async () => {
    const { app, auth } = await setup();

    const response = await app.inject({
      method: "POST",
      url: UPLOAD,
      headers: { ...auth, "content-type": "application/octet-stream" },
      payload: randomBytes(2048),
    });

    expect(response.statusCode).toBe(413);
    expectPublicContract("POST", UPLOAD, response);
  });

  it("429 when rate limited", async () => {
    const { app, auth } = await setup({ rateLimits: { requestsPerKey: 1 } });

    await app.inject({ method: "GET", url: DOWNLOAD, headers: auth });
    const response = await app.inject({
      method: "GET",
      url: DOWNLOAD,
      headers: auth,
    });

    expect(response.statusCode).toBe(429);
    expectPublicContract("GET", DOWNLOAD, response);
  });

  it("500 for an internal error", async () => {
    const failing = {
      select: () => {
        throw new Error("database is down");
      },
    } as unknown as Database;
    const app = await startGateway({ db: failing });

    const response = await app.inject({
      method: "GET",
      url: DOWNLOAD,
      headers: {
        authorization:
          "Bearer sk_test_0123456789abcdef_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
    });

    expect(response.statusCode).toBe(500);
    expectPublicContract("GET", DOWNLOAD, response);
  });

  it("502 when storage is down", async () => {
    const { app, auth } = await setup({ storageUrl: "http://127.0.0.1:1" });

    const response = await app.inject({
      method: "GET",
      url: DOWNLOAD,
      headers: auth,
    });

    expect(response.statusCode).toBe(502);
    expectPublicContract("GET", DOWNLOAD, response);
  });

  it("504 when storage is too slow", async () => {
    const slowUrl = await startFakeStorage((_req, res) => {
      setTimeout(() => res.end(), 2_000);
    });
    const { app, auth } = await setup({
      storageUrl: slowUrl,
      responseTimeoutMs: 100,
    });

    const response = await app.inject({
      method: "GET",
      url: DOWNLOAD,
      headers: auth,
    });

    expect(response.statusCode).toBe(504);
    expectPublicContract("GET", DOWNLOAD, response);
  });

  it("503 for a bad key while Redis is down", async () => {
    const { app, store } = await setup();
    store.fail = true;

    const response = await app.inject({
      method: "GET",
      url: DOWNLOAD,
      headers: { authorization: "Bearer wrong" },
    });

    expect(response.statusCode).toBe(503);
    expectPublicContract("GET", DOWNLOAD, response);
  });

  it("/health and /ready", async () => {
    const { app } = await setup();
    const broken = await startGateway({
      db: {
        execute: () => Promise.reject(new Error("down")),
      } as unknown as Database,
    });

    const health = await app.inject({ method: "GET", url: "/health" });
    const ready = await app.inject({ method: "GET", url: "/ready" });
    const notReady = await broken.inject({ method: "GET", url: "/ready" });

    expect([health.statusCode, ready.statusCode, notReady.statusCode]).toEqual([
      200, 200, 503,
    ]);
    expectPublicContract("GET", "/health", health);
    expectPublicContract("GET", "/ready", ready);
    expectPublicContract("GET", "/ready", notReady);
  });
});

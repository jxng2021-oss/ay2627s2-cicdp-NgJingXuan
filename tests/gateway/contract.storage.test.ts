import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  expectPublicContract,
  startContractStorage,
  storageError,
  type StorageReply,
} from "./contract-helpers.js";
import {
  createTenantWithKey,
  createTestDatabase,
  startGateway,
} from "./helpers.js";

const FILE_ID = "3f2c9b1e-6a4d-4c8e-9f1a-2b3c4d5e6f70";

async function setup(reply: Parameters<typeof startContractStorage>[0]) {
  const storage = await startContractStorage(reply);
  const { db } = await createTestDatabase();
  const app = await startGateway({ db, storageUrl: storage.url });
  const tenant = await createTenantWithKey(app);
  const auth = { authorization: `Bearer ${tenant.key}` };
  return { app, storage, tenant, auth };
}

const created = (size: number): StorageReply => ({
  status: 201,
  contentType: "application/json; charset=utf-8",
  body: JSON.stringify({
    id: FILE_ID,
    size,
    name: null,
    contentType: "application/octet-stream",
    createdAt: "2026-11-05T09:30:00.000Z",
  }),
});

describe("the gateway uses storage as the internal contract says", () => {
  it("uploads: POST /files with the tenant and request ID, and passes on the 201", async () => {
    const { app, storage, tenant, auth } = await setup((_req, body) =>
      created(body.length),
    );
    const file = randomBytes(2048);

    const response = await app.inject({
      method: "POST",
      url: "/v1/storage/files",
      headers: { ...auth, "content-type": "application/octet-stream" },
      payload: file,
    });

    expect(storage.problems).toEqual([]);
    expect(storage.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      "POST /files",
    ]);
    expect(storage.requests[0]?.headers["x-tenant-id"]).toBe(tenant.tenantId);
    expect(storage.requests[0]?.headers["x-request-id"]).toBe(
      response.headers["x-request-id"],
    );
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ id: FILE_ID, size: 2048 });
    expectPublicContract("POST", "/v1/storage/files", response);
  });

  it("downloads: GET /files/{id} and streams the bytes back", async () => {
    const file = randomBytes(4096);
    const { app, storage, auth } = await setup(() => ({
      status: 200,
      contentType: "application/octet-stream",
      headers: {
        "content-disposition": 'attachment; filename="f"',
        "x-content-type-options": "nosniff",
      },
      body: file,
    }));

    const response = await app.inject({
      method: "GET",
      url: `/v1/storage/files/${FILE_ID}`,
      headers: auth,
    });

    expect(storage.problems).toEqual([]);
    expect(storage.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET /files/${FILE_ID}`,
    ]);
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.equals(file)).toBe(true);
    expectPublicContract("GET", `/v1/storage/files/${FILE_ID}`, response);
  });

  it("passes storage's 404 (missing file, or another tenant's) to the client with the same request ID", async () => {
    const { app, storage, auth } = await setup((req) =>
      storageError(req, 404, "NOT_FOUND"),
    );

    const response = await app.inject({
      method: "GET",
      url: `/v1/storage/files/${FILE_ID}`,
      headers: auth,
    });

    expect(storage.problems).toEqual([]);
    expect(response.statusCode).toBe(404);
    const body = response.json<{
      error: { code: string; requestId: string };
    }>();
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.requestId).toBe(response.headers["x-request-id"]);
    expectPublicContract("GET", `/v1/storage/files/${FILE_ID}`, response);
  });

  it.each([
    ["POST", "/v1/storage/files", 413, "PAYLOAD_TOO_LARGE"],
    ["POST", "/v1/storage/files", 500, "INTERNAL_ERROR"],
    ["POST", "/v1/storage/files", 503, "SERVICE_UNAVAILABLE"],
    ["GET", `/v1/storage/files/${FILE_ID}`, 500, "INTERNAL_ERROR"],
    ["GET", `/v1/storage/files/${FILE_ID}`, 503, "SERVICE_UNAVAILABLE"],
  ] as const)(
    "passes storage errors through within the public contract: %s %s -> %i",
    async (method, url, status, code) => {
      const { app, storage, auth } = await setup((req) =>
        storageError(req, status, code),
      );

      const response = await app.inject({
        method,
        url,
        headers: { ...auth, "content-type": "application/octet-stream" },
        payload: method === "POST" ? Buffer.from("x") : undefined,
      });

      expect(storage.problems).toEqual([]);
      expect(response.statusCode).toBe(status);
      expectPublicContract(method, url, response);
    },
  );

  it("never sends storage a malformed ID or an unauthenticated request", async () => {
    const { app, storage, auth } = await setup(() => created(0));

    await app.inject({
      method: "GET",
      url: "/v1/storage/files/not-an-id",
      headers: auth,
    });
    await app.inject({ method: "GET", url: `/v1/storage/files/${FILE_ID}` });

    expect(storage.requests).toEqual([]);
  });
});

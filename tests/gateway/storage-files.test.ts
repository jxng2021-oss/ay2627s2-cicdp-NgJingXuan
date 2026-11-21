import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import {
  expectPublicContract,
  serviceError,
  startContractStorage,
  type ReceivedRequest,
  type ServiceReply,
} from "./contract-helpers.js";
import {
  createTenantWithKey,
  createTestDatabase,
  expectError,
  startGateway,
} from "./helpers.js";

const FILE_ID = "3f2c9b1e-6a4d-4c8e-9f1a-2b3c4d5e6f70";
const META = {
  id: FILE_ID,
  size: 5,
  name: "a b.txt",
  contentType: "text/plain",
  createdAt: "2026-11-05T09:30:00.000Z",
};

let app: FastifyInstance;
let auth: { authorization: string };
let tenantId: string;
let storage: Awaited<ReturnType<typeof startContractStorage>>;

const json = (status: number, body: unknown): ServiceReply => ({
  status,
  contentType: "application/json; charset=utf-8",
  body: JSON.stringify(body),
});

async function setup(reply: (req: ReceivedRequest) => ServiceReply) {
  storage = await startContractStorage((req) => reply(req));
  const { db } = await createTestDatabase();
  app = await startGateway({ db, storageUrl: storage.url });
  const tenant = await createTenantWithKey(app);
  tenantId = tenant.tenantId;
  auth = { authorization: `Bearer ${tenant.key}` };
}

beforeEach(async () => {
  await setup((req) => {
    const path = req.url.split("?")[0];
    if (req.method === "GET" && path === "/files")
      return json(200, { files: [META], nextCursor: null });
    if (req.method === "GET" && path === "/usage")
      return json(200, { usedBytes: 5, reservedBytes: 0, limitBytes: 100 });
    if (req.method === "GET" && path === `/files/${FILE_ID}/metadata`)
      return json(200, META);
    if (req.method === "DELETE" && path === `/files/${FILE_ID}`)
      return { status: 204 };
    if (req.method === "POST") return json(201, META);
    return serviceError(req, 404, "NOT_FOUND");
  });
});

async function call(
  method: "GET" | "POST" | "DELETE",
  url: string,
  options: { headers?: Record<string, string>; body?: Buffer } = {},
): Promise<LightMyRequestResponse> {
  const response = await app.inject({
    method,
    url,
    headers: { ...auth, ...options.headers },
    payload: options.body,
  });
  expectPublicContract(method, url.split("?")[0]!, response);
  return response;
}

describe("file routes through the gateway", () => {
  it("list, metadata, usage and delete reach storage with the verified tenant", async () => {
    const list = await call("GET", "/v1/storage/files?limit=5&cursor=abc");
    const meta = await call("GET", `/v1/storage/files/${FILE_ID}/metadata`);
    const usage = await call("GET", "/v1/storage/usage");
    const deleted = await call("DELETE", `/v1/storage/files/${FILE_ID}`);

    expect([
      list.statusCode,
      meta.statusCode,
      usage.statusCode,
      deleted.statusCode,
    ]).toEqual([200, 200, 200, 204]);
    expect(list.json()).toEqual({ files: [META], nextCursor: null });
    expect(usage.json()).toEqual({
      usedBytes: 5,
      reservedBytes: 0,
      limitBytes: 100,
    });
    expect(storage.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      "GET /files?limit=5&cursor=abc",
      `GET /files/${FILE_ID}/metadata`,
      "GET /usage",
      `DELETE /files/${FILE_ID}`,
    ]);
    for (const request of storage.requests)
      expect(request.headers["x-tenant-id"]).toBe(tenantId);
    expect(storage.problems).toEqual([]);
  });

  it("passes the upload's filename on to storage", async () => {
    const response = await call("POST", "/v1/storage/files", {
      headers: { "content-type": "text/plain", "x-file-name": "a%20b.txt" },
      body: Buffer.from("hello"),
    });

    expect(response.json()).toEqual(META);
    expect(storage.requests[0]?.headers["x-file-name"]).toBe("a%20b.txt");
    expect(storage.problems).toEqual([]);
  });

  it("refuses bad IDs and queries before calling storage (400)", async () => {
    for (const url of [
      "/v1/storage/files/not-an-id/metadata",
      "/v1/storage/files?limit=0",
      "/v1/storage/files?limit=500",
    ]) {
      expectError(await call("GET", url), 400, "BAD_REQUEST");
    }
    expectError(
      await call("DELETE", "/v1/storage/files/not-an-id"),
      400,
      "BAD_REQUEST",
    );
    expect(storage.requests).toEqual([]);
  });

  it("needs an API key", async () => {
    auth = { authorization: "Bearer wrong" };

    expectError(await call("GET", "/v1/storage/files"), 401, "UNAUTHORIZED");
    expect(storage.requests).toEqual([]);
  });

  it.each([
    ["POST", "/v1/storage/files", 503, "SECRETS_SEALED"],
    ["GET", `/v1/storage/files/${FILE_ID}`, 503, "SECRETS_SEALED"],
    ["POST", "/v1/storage/files", 413, "STORAGE_QUOTA_EXCEEDED"],
  ] as const)(
    "passes %s %s -> %i %s through, within the public contract",
    async (method, url, status, code) => {
      await setup((req) => serviceError(req, status, code));

      const response = await call(
        method,
        url,
        method === "POST" ? { body: Buffer.from("x") } : {},
      );

      expectError(response, status, code);
      expect(storage.problems).toEqual([]);
    },
  );

  it("passes the safe-download headers through", async () => {
    await setup(() => ({
      status: 200,
      contentType: "application/octet-stream",
      headers: {
        "content-disposition":
          "attachment; filename=\"a_b.txt\"; filename*=UTF-8''a%20b.txt",
        "x-content-type-options": "nosniff",
      },
      body: Buffer.from("hello"),
    }));

    const response = await call("GET", `/v1/storage/files/${FILE_ID}`);

    expect(response.headers["content-disposition"]).toMatch(/^attachment; /);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.body).toBe("hello");
  });

  it.each([
    "/v1/internal/file-keys/wrap",
    "/internal/file-keys/unwrap",
    "/v1/storage/../internal/file-keys/wrap",
    "/v1/secrets/..%2finternal%2ffile-keys%2fwrap",
    "/v1/storage/files/..%2f..%2finternal%2ffile-keys%2fwrap",
  ])(
    "the secrets service's file-key route %s can't be reached through the gateway",
    async (url) => {
      const response = await app.inject({
        method: "POST",
        url,
        headers: { ...auth, "content-type": "application/json" },
        payload: { fileId: FILE_ID, key: "x" },
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.statusCode).not.toBe(200);
      expect(
        storage.requests.filter((r) => r.url.includes("file-keys")),
      ).toEqual([]);
    },
  );
});

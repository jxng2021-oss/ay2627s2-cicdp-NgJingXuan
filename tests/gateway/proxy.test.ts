import { randomBytes } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { describe, expect, it } from "vitest";
import {
  createTenantWithKey,
  createTestDatabase,
  expectError,
  startFakeStorage,
  startGateway,
} from "./helpers.js";

const FOUND = "3f2c9b1e-6a4d-4c8e-9f1a-2b3c4d5e6f70";

async function gatewayWithKey(storageUrl: string, responseTimeoutMs = 1_000) {
  const { db } = await createTestDatabase();
  const app = await startGateway({ db, storageUrl, responseTimeoutMs });
  const { key, tenantId } = await createTenantWithKey(app);
  return { app, tenantId, auth: { authorization: `Bearer ${key}` } };
}

describe("gateway proxy", () => {
  it("reports healthy without a key and without contacting storage", async () => {
    const { db } = await createTestDatabase();
    const app = await startGateway({ db });

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("forwards uploads to storage's POST /files", async () => {
    let received: {
      method?: string;
      url?: string;
      contentType?: string;
      body?: Buffer;
    } = {};
    const storageUrl = await startFakeStorage((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        received = {
          method: req.method,
          url: req.url,
          contentType: req.headers["content-type"],
          body: Buffer.concat(chunks),
        };
        res.writeHead(201, { "content-type": "application/json" });
        res.end('{"id":"abc"}');
      });
    });
    const { app, auth } = await gatewayWithKey(storageUrl);
    const original = randomBytes(64 * 1024);

    const response = await app.inject({
      method: "POST",
      url: "/v1/storage/files?source=test",
      headers: { ...auth, "content-type": "application/octet-stream" },
      payload: original,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ id: "abc" });
    expect(received.method).toBe("POST");
    expect(received.url).toBe("/files");
    expect(received.contentType).toBe("application/octet-stream");
    expect(received.body?.equals(original)).toBe(true);
  });

  it("sends the verified tenant to storage and keeps the API key in the gateway", async () => {
    let headers: IncomingHttpHeaders = {};
    const storageUrl = await startFakeStorage((req, res) => {
      headers = req.headers;
      res.end();
    });
    const { app, auth, tenantId } = await gatewayWithKey(storageUrl);

    await app.inject({
      method: "GET",
      url: "/v1/storage/files/00000000-0000-4000-8000-000000000000",
      headers: auth,
    });

    expect(headers["x-tenant-id"]).toBe(tenantId);
    expect(headers.authorization).toBeUndefined();
  });

  it("replaces a spoofed X-Tenant-Id header with the key's tenant", async () => {
    let tenantHeader: string | string[] | undefined;
    const storageUrl = await startFakeStorage((req, res) => {
      tenantHeader = req.headers["x-tenant-id"];
      res.end();
    });
    const { app, auth, tenantId } = await gatewayWithKey(storageUrl);
    const otherTenant = "00000000-0000-4000-8000-000000000000";

    await app.inject({
      method: "GET",
      url: "/v1/storage/files/00000000-0000-4000-8000-000000000000",
      headers: {
        ...auth,
        "x-tenant-id": otherTenant,
        "X-Tenant-ID": otherTenant,
      },
    });

    expect(tenantHeader).toBe(tenantId);
  });

  it("handles uploads sent with Expect: 100-continue (as curl does for large files)", async () => {
    let receivedExpect: string | undefined = "not called";
    const storageUrl = await startFakeStorage((req, res) => {
      receivedExpect = req.headers.expect;
      req.resume();
      req.on("end", () => res.writeHead(201).end());
    });
    const { app, auth } = await gatewayWithKey(storageUrl);

    const response = await app.inject({
      method: "POST",
      url: "/v1/storage/files",
      headers: {
        ...auth,
        "content-type": "application/octet-stream",
        expect: "100-continue",
      },
      payload: Buffer.from("hello"),
    });

    expect(response.statusCode).toBe(201);
    expect(receivedExpect).toBeUndefined();
  });

  it("passes downloads and storage status codes back to the client", async () => {
    const file = randomBytes(64 * 1024);
    const storageUrl = await startFakeStorage((req, res) => {
      if (req.url === `/files/${FOUND}`) {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(file);
      } else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end('{"message":"File not found"}');
      }
    });
    const { app, auth } = await gatewayWithKey(storageUrl);

    const found = await app.inject({
      method: "GET",
      url: `/v1/storage/files/${FOUND}`,
      headers: auth,
    });
    const missing = await app.inject({
      method: "GET",
      url: "/v1/storage/files/00000000-0000-4000-8000-000000000000",
      headers: auth,
    });

    expect(found.statusCode).toBe(200);
    expect(found.rawPayload.equals(file)).toBe(true);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ message: "File not found" });
  });

  it("serves only the v1 routes: old, unknown and malformed paths never reach storage", async () => {
    let storageCalls = 0;
    const storageUrl = await startFakeStorage((_req, res) => {
      storageCalls += 1;
      res.end();
    });
    const { app, auth } = await gatewayWithKey(storageUrl);
    const get = (url: string) =>
      app.inject({ method: "GET", url, headers: auth });

    expectError(await get(`/storage/files/${FOUND}`), 404, "NOT_FOUND");
    expectError(await get("/v1/storage//evil.example/x"), 404, "NOT_FOUND");
    expectError(await get("/v1/storage/other"), 404, "NOT_FOUND");
    expectError(await get("/v1/storage/files/not-an-id"), 400, "BAD_REQUEST");
    expectError(
      await get("/v1/storage/files/..%2F..%2Fetc%2Fpasswd"),
      400,
      "BAD_REQUEST",
    );
    expect(storageCalls).toBe(0);
  });

  it("returns 502 when storage is unavailable", async () => {
    const { app, auth } = await gatewayWithKey("http://127.0.0.1:1");

    const response = await app.inject({
      method: "GET",
      url: "/v1/storage/files/00000000-0000-4000-8000-000000000000",
      headers: auth,
    });

    expectError(
      response,
      502,
      "UPSTREAM_UNAVAILABLE",
      "Storage service is unavailable",
    );
  });

  it("returns 504 when storage takes too long to respond", async () => {
    const storageUrl = await startFakeStorage((_req, res) => {
      setTimeout(() => res.end(), 2_000);
    });
    const { app, auth } = await gatewayWithKey(storageUrl, 100);

    const response = await app.inject({
      method: "GET",
      url: "/v1/storage/files/00000000-0000-4000-8000-000000000000",
      headers: auth,
    });

    expectError(
      response,
      504,
      "UPSTREAM_TIMEOUT",
      "Storage service did not respond in time",
    );
  });
});

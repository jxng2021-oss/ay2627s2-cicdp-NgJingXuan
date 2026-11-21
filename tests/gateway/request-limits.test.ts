import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { request } from "undici";
import {
  createTenantWithKey,
  createTestDatabase,
  expectError,
  startFakeStorage,
  startGateway,
  TEST_SERVER_LIMITS,
} from "./helpers.js";

const MAX_UPLOAD = 64 * 1024;

async function setup() {
  const { db } = await createTestDatabase();
  const uploads: { completed: boolean; bytes: number }[] = [];
  const storageUrl = await startFakeStorage((req, res) => {
    const upload = { completed: false, bytes: 0 };
    uploads.push(upload);
    req.on("data", (chunk: Buffer) => (upload.bytes += chunk.length));
    req.on("end", () => {
      upload.completed = true;
      res.writeHead(201).end("{}");
    });
  });
  const app = await startGateway({
    db,
    storageUrl,
    maxUploadBytes: MAX_UPLOAD,
  });
  const { key } = await createTenantWithKey(app);
  return { app, key, uploads };
}

function chunks(count: number, size: number): Readable {
  let sent = 0;
  return new Readable({
    read() {
      this.push(sent++ < count ? Buffer.alloc(size, 1) : null);
    },
  });
}

describe("upload size limit", () => {
  it("refuses an upload whose Content-Length is too large, without contacting storage", async () => {
    const { app, key, uploads } = await setup();

    const response = await app.inject({
      method: "POST",
      url: "/v1/storage/files",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/octet-stream",
      },
      payload: Buffer.alloc(MAX_UPLOAD + 1),
    });

    expectError(response, 413, "PAYLOAD_TOO_LARGE");
    expect(uploads).toHaveLength(0);
  });

  it("stops an upload with no Content-Length once it goes over, and cancels it at storage", async () => {
    const { app, key, uploads } = await setup();

    const response = await app.inject({
      method: "POST",
      url: "/v1/storage/files",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/octet-stream",
      },
      payload: chunks(10, 16 * 1024),
    });

    expectError(response, 413, "PAYLOAD_TOO_LARGE");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(uploads).toHaveLength(1);
    expect(uploads.every((u) => !u.completed)).toBe(true);
    expect(uploads.every((u) => u.bytes <= MAX_UPLOAD)).toBe(true);
  });

  it("accepts an upload at the limit", async () => {
    const { app, key, uploads } = await setup();

    const response = await app.inject({
      method: "POST",
      url: "/v1/storage/files",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/octet-stream",
      },
      payload: chunks(4, 16 * 1024),
    });

    expect(response.statusCode).toBe(201);
    expect(uploads[0]).toEqual({ completed: true, bytes: MAX_UPLOAD });
  });
});

describe("upload size limit over a real connection", () => {
  async function listening() {
    const { app, key, uploads } = await setup();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/v1/storage/files`;
    const headers = {
      authorization: `Bearer ${key}`,
      "content-type": "application/octet-stream",
    };
    return { url, headers, uploads };
  }

  it.each([
    ["with Content-Length", () => Buffer.alloc(16 * MAX_UPLOAD)],
    ["without Content-Length", () => chunks(16, MAX_UPLOAD)],
  ])("lets the client read the 413 (%s)", async (_case, body) => {
    const { url, headers, uploads } = await listening();
    const started = Date.now();

    const response = await request(url, {
      method: "POST",
      headers,
      body: body(),
    });

    expect(response.statusCode).toBe(413);
    const parsed = (await response.body.json()) as { error: { code: string } };
    expect(parsed.error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(uploads.every((u) => !u.completed)).toBe(true);
  });
});

describe("HTTP server limits", () => {
  it("refuses requests with oversized headers (431)", async () => {
    const { db } = await createTestDatabase();
    const app = await startGateway({
      db,
      server: { ...TEST_SERVER_LIMITS, maxHeaderBytes: 1024 },
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;

    const response = await request(`http://127.0.0.1:${port}/health`, {
      headers: { "x-padding": "a".repeat(4096) },
    });

    expect(response.statusCode).toBe(431);
    await response.body.dump();
  });

  it("disconnects clients that send their headers too slowly", async () => {
    const { db } = await createTestDatabase();
    const app = await startGateway({
      db,
      server: { ...TEST_SERVER_LIMITS, headersTimeoutMs: 500 },
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;

    const socket = connect(port, "127.0.0.1");
    socket.write("GET /health HTTP/1.1\r\nHost: localhost\r\n");
    const started = Date.now();
    const reply = await new Promise<string>((resolve) => {
      let text = "";
      socket.on("data", (chunk: Buffer) => (text += chunk.toString()));
      socket.on("close", () => resolve(text));
    });

    expect(reply).toMatch(/^HTTP\/1\.1 408/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

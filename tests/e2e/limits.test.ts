import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  admin,
  createTenantWithKey,
  download,
  expectError,
  freshWindow,
  GATEWAY_URL,
  LIMITS,
  upload,
  UUID_PATTERN,
} from "./helpers.js";

beforeEach(freshWindow);

const MISSING_FILE = "00000000-0000-4000-8000-000000000000";

describe("rate limits (Redis)", () => {
  it("limits each key, with headers, then recovers after the window", async () => {
    const { key } = await createTenantWithKey("e2e-limit");
    const get = () => download(MISSING_FILE, `Bearer ${key}`);

    const first = await get();
    expect(first.headers.get("ratelimit-limit")).toBe(
      String(LIMITS.requestsPerKey),
    );
    expect(first.headers.get("ratelimit-remaining")).toBe(
      String(LIMITS.requestsPerKey - 1),
    );
    expect(Number(first.headers.get("ratelimit-reset"))).toBeGreaterThanOrEqual(
      1,
    );
    for (let i = 1; i < LIMITS.requestsPerKey; i++) await get();

    const limited = await get();
    await expectError(limited, 429, "RATE_LIMITED");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(
      1,
    );

    await freshWindow();
    expect((await get()).status).toBe(404);
  });

  it("never lets simultaneous requests exceed the limit (atomic counting in Redis)", async () => {
    const { key } = await createTenantWithKey("e2e-concurrent");

    const responses = await Promise.all(
      Array.from({ length: LIMITS.requestsPerKey * 3 }, () =>
        download(MISSING_FILE, `Bearer ${key}`),
      ),
    );

    const allowed = responses.filter((r) => r.status === 404).length;
    const limited = responses.filter((r) => r.status === 429).length;
    expect(allowed).toBe(LIMITS.requestsPerKey);
    expect(limited).toBe(LIMITS.requestsPerKey * 2);
  });

  it("keeps separate limits for separate keys", async () => {
    const a = await createTenantWithKey("e2e-key-a");
    const b = await createTenantWithKey("e2e-key-b");
    for (let i = 0; i < LIMITS.requestsPerKey; i++)
      await download(MISSING_FILE, `Bearer ${a.key}`);

    expect((await download(MISSING_FILE, `Bearer ${a.key}`)).status).toBe(429);
    expect((await download(MISSING_FILE, `Bearer ${b.key}`)).status).toBe(404);
  });

  it("blocks an IP after repeated failed attempts, even with a fake X-Forwarded-For, without revealing valid keys", async () => {
    const { key } = await createTenantWithKey("e2e-failed");
    const attempt = (authorization: string, i: number) =>
      download(MISSING_FILE, authorization, {
        "x-forwarded-for": `198.51.100.${i}`,
      });

    for (let i = 0; i < LIMITS.failedAuthPerIp; i++) {
      expect((await attempt("Bearer wrong", i)).status).toBe(401);
    }

    await expectError(await attempt("Bearer wrong", 99), 429, "RATE_LIMITED");
    await expectError(await attempt(`Bearer ${key}`, 98), 429, "RATE_LIMITED");

    await freshWindow();
    expect((await download(MISSING_FILE, `Bearer ${key}`)).status).toBe(404);
  });

  it("limits admin requests per IP", async () => {
    const responses = [];
    for (let i = 0; i <= LIMITS.adminPerIp; i++)
      responses.push(await admin("POST", "/tenants", {}));

    expect(
      responses.slice(0, LIMITS.adminPerIp).every((r) => r.status === 400),
    ).toBe(true);
    await expectError(
      responses[LIMITS.adminPerIp] as Response,
      429,
      "RATE_LIMITED",
    );
  });

  it("limits uploads per key", async () => {
    const { key } = await createTenantWithKey("e2e-uploads");
    for (let i = 0; i < LIMITS.uploadsPerKey; i++) {
      expect((await upload(key, Buffer.from("x"))).status).toBe(201);
    }

    await expectError(await upload(key, Buffer.from("x")), 429, "RATE_LIMITED");
  });
});

describe("upload size limit", () => {
  it("refuses an upload whose Content-Length is too large", async () => {
    const { key } = await createTenantWithKey("e2e-too-large");

    const response = await upload(key, randomBytes(LIMITS.maxUploadBytes + 1));

    await expectError(response, 413, "PAYLOAD_TOO_LARGE");
  });

  it("stops an upload without Content-Length once it goes over", async () => {
    const { key } = await createTenantWithKey("e2e-too-large-stream");
    const chunk = randomBytes(1024 * 1024);
    let sent = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (sent++ < LIMITS.maxUploadBytes / chunk.length + 2)
          controller.enqueue(chunk);
        else controller.close();
      },
    });

    const response = await upload(key, body).catch(() => undefined);

    if (response) await expectError(response, 413, "PAYLOAD_TOO_LARGE");
  });
});

describe("request IDs and errors", () => {
  it("returns its own X-Request-Id, ignoring the client's, and uses it in errors", async () => {
    const response = await fetch(`${GATEWAY_URL}/nope`, {
      headers: { "x-request-id": "11111111-1111-4111-8111-111111111111" },
    });

    const id = response.headers.get("x-request-id");
    expect(id).toMatch(UUID_PATTERN);
    expect(id).not.toBe("11111111-1111-4111-8111-111111111111");
    const body = await expectError(response, 404, "NOT_FOUND");
    expect(body.error.requestId).toBe(id);
  });

  it("uses the same request ID in storage's errors", async () => {
    const { key } = await createTenantWithKey("e2e-request-id");

    const response = await download(MISSING_FILE, `Bearer ${key}`);

    await expectError(response, 404, "NOT_FOUND");
  });
});

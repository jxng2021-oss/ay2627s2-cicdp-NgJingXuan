import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Database } from "../../services/gateway/src/db/client.js";
import {
  ADMIN_TOKEN,
  adminHeaders,
  captureLogs,
  createTenantWithKey,
  createTestDatabase,
  expectError,
  startFakeStorage,
  startGateway,
  UUID_PATTERN,
} from "./helpers.js";

describe("request IDs", () => {
  it("gives every response a new X-Request-Id, ignoring the client's", async () => {
    const { db } = await createTestDatabase();
    const app = await startGateway({ db });
    const clientId = "11111111-1111-4111-8111-111111111111";

    const first = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": clientId },
    });
    const second = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": clientId },
    });

    expect(first.headers["x-request-id"]).toMatch(UUID_PATTERN);
    expect(first.headers["x-request-id"]).not.toBe(clientId);
    expect(second.headers["x-request-id"]).not.toBe(
      first.headers["x-request-id"],
    );
  });

  it("passes its own request ID to storage, not the client's", async () => {
    const { db } = await createTestDatabase();
    let sentToStorage: string | string[] | undefined;
    const storageUrl = await startFakeStorage((req, res) => {
      sentToStorage = req.headers["x-request-id"];
      res.end();
    });
    const app = await startGateway({ db, storageUrl });
    const { key } = await createTenantWithKey(app);

    const response = await app.inject({
      method: "GET",
      url: "/v1/storage/files/00000000-0000-4000-8000-000000000000",
      headers: {
        authorization: `Bearer ${key}`,
        "x-request-id": "client-chosen-id",
      },
    });

    expect(sentToStorage).toBe(response.headers["x-request-id"]);
    expect(sentToStorage).not.toBe("client-chosen-id");
  });

  it("writes one JSON line per request with service, version, request ID, route, status and duration", async () => {
    const { db } = await createTestDatabase();
    const logs = captureLogs();
    const app = await startGateway({
      db,
      logger: { level: "info", stream: logs.stream },
    });

    const response = await app.inject({ method: "GET", url: "/health" });

    const lines = logs
      .text()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const forRequest = lines.filter(
      (line) => line.requestId === response.headers["x-request-id"],
    );
    expect(forRequest).toEqual([
      expect.objectContaining({
        msg: "request completed",
        service: "gateway",
        version: "dev",
        method: "GET",
        route: "/health",
        status: 200,
        durationMs: expect.any(Number) as number,
      }),
    ]);
  });
});

describe("error format", () => {
  it("uses the standard format for unknown routes", async () => {
    const { db } = await createTestDatabase();
    const app = await startGateway({ db });

    expectError(
      await app.inject({ method: "GET", url: "/nope" }),
      404,
      "NOT_FOUND",
    );
  });

  it("uses the standard format for invalid input", async () => {
    const { db } = await createTestDatabase();
    const app = await startGateway({ db });

    const response = await app.inject({
      method: "POST",
      url: "/admin/tenants",
      headers: adminHeaders,
      payload: { wrong: true },
    });

    expectError(response, 400, "BAD_REQUEST");
  });

  it("hides internal details (database errors, hostnames, stack traces) from clients", async () => {
    const failing = {
      select: () => {
        throw new Error(
          "connect ECONNREFUSED postgres://platform:s3cret@db-internal:5432",
        );
      },
    } as unknown as Database;
    const logs = captureLogs();
    const app = await startGateway({
      db: failing,
      logger: { level: "info", stream: logs.stream },
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/storage/files/00000000-0000-4000-8000-000000000000",
      headers: {
        authorization:
          "Bearer sk_test_0123456789abcdef_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
    });

    expectError(response, 500, "INTERNAL_ERROR", "Something went wrong");
    expect(response.body).not.toMatch(
      /ECONNREFUSED|s3cret|db-internal|5432|at |\.ts/,
    );
    expect(logs.text()).toContain("ECONNREFUSED");
    expect(logs.text()).toContain(response.headers["x-request-id"]);
  });
});

describe("secrets in logs and errors", () => {
  it("never logs or returns API keys, admin tokens, Authorization headers or file contents", async () => {
    const { db } = await createTestDatabase();
    const fileContent = randomBytes(32).toString("hex");
    const storageUrl = await startFakeStorage((req, res) => {
      req.resume();
      req.on("end", () => res.writeHead(201).end('{"id":"x"}'));
    });
    const logs = captureLogs();
    const app = await startGateway({
      db,
      storageUrl,
      logger: { level: "trace", stream: logs.stream },
      rateLimits: { failedAuthPerIp: 3 },
    });
    const { key } = await createTenantWithKey(app);

    const responses = await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/storage/files",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/octet-stream",
        },
        payload: fileContent,
      }),
      app.inject({
        method: "GET",
        url: "/v1/storage/files/00000000-0000-4000-8000-000000000000",
        headers: { authorization: `Bearer ${key}x` },
      }),
      app.inject({
        method: "GET",
        url: "/admin/tenants",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}x` },
      }),
    ]);
    for (let i = 0; i < 4; i++) {
      responses.push(
        await app.inject({
          method: "GET",
          url: "/v1/storage/files/00000000-0000-4000-8000-000000000000",
          headers: { authorization: `Bearer ${key}x` },
        }),
      );
    }

    const everything =
      logs.text() +
      responses.map((r) => r.body + JSON.stringify(r.headers)).join("\n");
    expect(logs.text()).toContain("request completed");
    for (const secret of [
      key,
      key.slice(-43),
      ADMIN_TOKEN,
      `Bearer ${key}`,
      fileContent,
    ]) {
      expect(everything).not.toContain(secret);
    }
    expect(logs.text().toLowerCase()).not.toContain("authorization");
  });
});

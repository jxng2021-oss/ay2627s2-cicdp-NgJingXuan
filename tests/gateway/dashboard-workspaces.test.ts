import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { insertMembership } from "../../services/gateway/src/models/membership.model.js";
import type { Database } from "../../services/gateway/src/db/client.js";
import {
  Browser,
  COOKIE,
  fakeAuditEvents,
  fakeSecrets,
  fakeStorage,
} from "./dashboard-helpers.js";
import {
  createTestDatabase,
  DASHBOARD_ORIGIN,
  expectError,
  FakeAudit,
  startFakeStorage,
  startGateway,
} from "./helpers.js";

let db: Database;
let app: FastifyInstance;
let audit: FakeAudit;
let secrets: Awaited<ReturnType<typeof fakeSecrets>>;
let storage: Awaited<ReturnType<typeof fakeStorage>>;
let auditService: Awaited<ReturnType<typeof fakeAuditEvents>>;
let owner: Browser;
let workspace: string;

beforeEach(async () => {
  ({ db } = await createTestDatabase());
  audit = new FakeAudit();
  secrets = await fakeSecrets();
  storage = await fakeStorage();
  auditService = await fakeAuditEvents();
  app = await startGateway({
    db,
    audit,
    secretsUrl: secrets.url,
    storageUrl: storage.url,
    auditUrl: auditService.url,
  });
  owner = new Browser(app);
  workspace = await owner.signUp("owner@example.com", "Owner's workspace");
});

async function member(): Promise<Browser> {
  const browser = new Browser(app);
  await browser.signUp("member@example.com", "Member's own");
  const me = await browser.request("GET", "/dashboard/v1/auth/me");
  const userId = me.json<{ user: { id: string } }>().user.id;
  await insertMembership(db, { userId, tenantId: workspace, role: "member" });
  return browser;
}

const FILE_ID = randomUUID();
const KEY_ID = randomUUID();

const ROUTES: [
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
][] = [
  ["GET", ""],
  ["GET", "/api-keys"],
  ["POST", "/api-keys", { name: "k" }],
  ["DELETE", `/api-keys/${KEY_ID}`],
  ["DELETE", `/revoked-api-keys/${KEY_ID}`],
  ["GET", "/secrets"],
  ["PUT", "/secrets/db-password", { value: "v" }],
  ["POST", "/secrets/db-password/rotate", { value: "v" }],
  ["DELETE", "/secrets/db-password"],
  ["GET", "/secrets/db-password/versions"],
  ["GET", "/files"],
  ["POST", "/files"],
  ["GET", `/files/${FILE_ID}`],
  ["GET", `/files/${FILE_ID}/metadata`],
  ["DELETE", `/files/${FILE_ID}`],
  ["GET", "/usage"],
  ["GET", "/proxy-connections"],
  [
    "PUT",
    "/proxy-connections/mock",
    {
      baseUrl: "https://api.example.com",
      secretName: "s",
      headerName: "X-Key",
    },
  ],
  ["DELETE", "/proxy-connections/mock"],
  ["GET", "/audit-events"],
  ["GET", "/analytics"],
];

const OWNER_ONLY = new Set([
  "POST /api-keys",
  `DELETE /api-keys/${KEY_ID}`,
  `DELETE /revoked-api-keys/${KEY_ID}`,
  "PUT /secrets/db-password",
  "POST /secrets/db-password/rotate",
  "DELETE /secrets/db-password",
  `DELETE /files/${FILE_ID}`,
  "PUT /proxy-connections/mock",
  "DELETE /proxy-connections/mock",
]);

function send(
  browser: Browser,
  ws: string,
  [method, path, body]: (typeof ROUTES)[number],
) {
  return browser.request(method, browser.ws(ws, path), {
    ...(body !== undefined
      ? { body }
      : method === "POST" && path === "/files"
        ? { raw: Buffer.from("x") }
        : {}),
  });
}

describe("access on every route", () => {
  it("another user's workspace is the same 404 as one that doesn't exist, on every route", async () => {
    const stranger = new Browser(app);
    await stranger.signUp("stranger@example.com", "Stranger's");

    for (const route of ROUTES) {
      const theirs = await send(stranger, workspace, route);
      const missing = await send(stranger, randomUUID(), route);
      expectError(theirs, 404, "NOT_FOUND");
      expectError(missing, 404, "NOT_FOUND");
      expect(theirs.json<{ error: { message: string } }>().error.message).toBe(
        missing.json<{ error: { message: string } }>().error.message,
      );
    }
    expect([
      ...secrets.requests,
      ...storage.requests,
      ...auditService.requests,
    ]).toEqual([]);
  });

  it("every route needs a session", async () => {
    const anonymous = new Browser(app);
    for (const route of ROUTES) {
      expectError(await send(anonymous, workspace, route), 401, "UNAUTHORIZED");
    }
  });

  it("members can't do owner-only actions (403), but can do everything else", async () => {
    const browser = await member();

    for (const route of ROUTES) {
      const response = await send(browser, workspace, route);
      const key = `${route[0]} ${route[1]}`;
      if (OWNER_ONLY.has(key)) {
        expectError(response, 403, "FORBIDDEN");
      } else {
        expect([401, 403], key).not.toContain(response.statusCode);
      }
    }
  });

  it("the tenant comes only from the membership: X-Tenant-Id and body fields are ignored", async () => {
    const stranger = new Browser(app);
    const theirs = await stranger.signUp("other@example.com", "Other");

    await owner.request("GET", owner.ws(workspace, "/files"), {
      headers: { "x-tenant-id": theirs },
    });
    await owner.request("PUT", owner.ws(workspace, "/secrets/db-password"), {
      body: { value: "v" },
      headers: { "x-tenant-id": theirs },
    });

    for (const request of [...storage.requests, ...secrets.requests]) {
      expect(request.headers["x-tenant-id"]).toBe(workspace);
      expect(request.headers.cookie).toBeUndefined();
      expect(request.headers["x-csrf-token"]).toBeUndefined();
    }
    expect(storage.problems).toEqual([]);
    expect(secrets.problems).toEqual([]);
  });

  it("changes need the CSRF token on workspace routes too, file uploads included", async () => {
    for (const [method, path, raw] of [
      ["POST", "/files", Buffer.from("x")],
      ["PUT", "/secrets/db-password", undefined],
      ["POST", "/api-keys", undefined],
    ] as const) {
      const response = await owner.request(method, owner.ws(workspace, path), {
        csrf: false,
        ...(raw
          ? { raw }
          : { body: method === "POST" ? { name: "k" } : { value: "v" } }),
      });
      expectError(response, 403, "FORBIDDEN");
    }
    expect([...secrets.requests, ...storage.requests]).toEqual([]);
  });
});

describe("owner routes", () => {
  it("overview", async () => {
    await owner.request("PUT", owner.ws(workspace, "/secrets/a"), {
      body: { value: "1" },
    });

    const response = await owner.request("GET", owner.ws(workspace));

    expect(response.json()).toEqual({
      id: workspace,
      name: "Owner's workspace",
      role: "owner",
      secretsCount: 1,
      fileCount: 0,
      storage: { usedBytes: 0, reservedBytes: 0, limitBytes: 1000 },
      secretsSealed: false,
    });
  });

  it("API keys: create (shown once), list (never the key) and revoke, recorded with the user as actor", async () => {
    const created = await owner.request(
      "POST",
      owner.ws(workspace, "/api-keys"),
      { body: { name: "ci" } },
    );
    const { apiKey, key } = created.json<{
      apiKey: { id: string };
      key: string;
    }>();
    const list = await owner.request("GET", owner.ws(workspace, "/api-keys"));
    const revoked = await owner.request(
      "DELETE",
      owner.ws(workspace, `/api-keys/${apiKey.id}`),
    );

    expect(created.statusCode).toBe(201);
    expect(key).toMatch(/^sk_test_/);
    expect(list.body).not.toContain(key);
    expect(list.json()).toMatchObject({
      apiKeys: [{ id: apiKey.id, name: "ci", status: "active" }],
    });
    expect(revoked.statusCode).toBe(204);
    expect(
      audit.events
        .filter((e) => e.action.startsWith("api_key."))
        .map((e) => [e.action, e.actorType, e.tenantId]),
    ).toEqual([
      ["api_key.created", "user", workspace],
      ["api_key.revoked", "user", workspace],
    ]);
    const used = await app.inject({
      method: "GET",
      url: "/v1/storage/files/not-an-id",
      headers: { authorization: `Bearer ${key}` },
    });
    expect(used.statusCode).toBe(401);
  });

  it("API keys: only a revoked key can be removed; it leaves the list and the removal is recorded", async () => {
    const created = await owner.request(
      "POST",
      owner.ws(workspace, "/api-keys"),
      { body: { name: "old" } },
    );
    const { apiKey } = created.json<{ apiKey: { id: string } }>();
    const removeActive = await owner.request(
      "DELETE",
      owner.ws(workspace, `/revoked-api-keys/${apiKey.id}`),
    );
    await owner.request(
      "DELETE",
      owner.ws(workspace, `/api-keys/${apiKey.id}`),
    );
    const removed = await owner.request(
      "DELETE",
      owner.ws(workspace, `/revoked-api-keys/${apiKey.id}`),
    );
    const again = await owner.request(
      "DELETE",
      owner.ws(workspace, `/revoked-api-keys/${apiKey.id}`),
    );
    const list = await owner.request("GET", owner.ws(workspace, "/api-keys"));

    expect(removeActive.statusCode).toBe(409);
    expect(removeActive.json()).toMatchObject({ error: { code: "CONFLICT" } });
    expect(removed.statusCode).toBe(204);
    expect(again.statusCode).toBe(404);
    expect(
      list.json<{ apiKeys: { id: string }[] }>().apiKeys.map((k) => k.id),
    ).not.toContain(apiKey.id);
    expect(
      audit.events
        .filter((e) => e.resourceId === apiKey.id)
        .map((e) => [e.action, e.actorType, e.tenantId]),
    ).toEqual([
      ["api_key.created", "user", workspace],
      ["api_key.revoked", "user", workspace],
      ["api_key.deleted", "user", workspace],
    ]);
  });

  it("secrets: write-only, so no route returns a value (no reveal, metadata only)", async () => {
    await owner.request("PUT", owner.ws(workspace, "/secrets/db-password"), {
      body: { value: "the-value-123" },
    });

    const list = await owner.request("GET", owner.ws(workspace, "/secrets"));
    const versions = await owner.request(
      "GET",
      owner.ws(workspace, "/secrets/db-password/versions"),
    );
    const reveal = await owner.request(
      "POST",
      owner.ws(workspace, "/secrets/db-password/reveal"),
    );

    expect(list.body).not.toContain("the-value-123");
    expect(versions.body).not.toContain("the-value-123");
    expectError(reveal, 404, "NOT_FOUND");
    expect(reveal.body).not.toContain("the-value-123");
    expect(secrets.requests.some((r) => r.url.endsWith("/reveal"))).toBe(false);
    expectError(
      await owner.request("GET", owner.ws(workspace, "/secrets/db-password")),
      404,
      "NOT_FOUND",
    );
  });

  it("files: upload, list, download and delete through the dashboard", async () => {
    const uploaded = await owner.request(
      "POST",
      owner.ws(workspace, "/files"),
      { raw: Buffer.from("dashboard file") },
    );
    const { id } = uploaded.json<{ id: string }>();
    const downloaded = await owner.request(
      "GET",
      owner.ws(workspace, `/files/${id}`),
    );
    const list = await owner.request("GET", owner.ws(workspace, "/files"));
    const deleted = await owner.request(
      "DELETE",
      owner.ws(workspace, `/files/${id}`),
    );

    expect(uploaded.statusCode).toBe(201);
    expect(downloaded.body).toBe("dashboard file");
    expect(downloaded.headers["content-disposition"]).toMatch(/^attachment/);
    expect(list.json<{ files: unknown[] }>().files).toHaveLength(1);
    expect(deleted.statusCode).toBe(204);
    expect(storage.problems).toEqual([]);
  });

  it("proxy connections and audit events", async () => {
    const created = await owner.request(
      "PUT",
      owner.ws(workspace, "/proxy-connections/mock"),
      {
        body: {
          baseUrl: "http://10.0.0.1",
          secretName: "s",
          headerName: "X-Key",
        },
      },
    );
    const events = await owner.request(
      "GET",
      owner.ws(workspace, "/audit-events?action=secret.read&limit=5"),
    );

    expectError(created, 400, "BAD_REQUEST");
    expect(events.statusCode).toBe(200);
    expect(auditService.requests[0]?.headers["x-tenant-id"]).toBe(workspace);
    const several = await owner.request(
      "GET",
      owner.ws(
        workspace,
        "/audit-events?action=secret.read&action=api_key.deleted&outcome=success&outcome=denied",
      ),
    );
    expect(several.statusCode).toBe(200);
    expect(auditService.requests.at(-1)?.url).toBe(
      "/events?action=secret.read&action=api_key.deleted&outcome=success&outcome=denied&limit=50",
    );
    expect(auditService.problems).toEqual([]);
  });
});

describe("streaming", () => {
  it("a large dashboard upload is streamed, holding only a little memory", async () => {
    const size = 96 * 1024 * 1024;
    let received = 0;
    const every = 8 * 1024 * 1024;
    let lowest = Infinity;
    let highest = -Infinity;
    let samples = 0;
    const sample = () => {
      const gc = (globalThis as { gc?: () => void }).gc;
      gc?.();
      samples++;
      if (samples <= 2) return;
      const held = process.memoryUsage().arrayBuffers;
      lowest = Math.min(lowest, held);
      highest = Math.max(highest, held);
    };
    const discardingStorage = await startFakeStorage((req, res) => {
      req.on("data", (chunk: Buffer) => {
        const before = Math.floor(received / every);
        received += chunk.length;
        if (Math.floor(received / every) > before) sample();
      });
      req.on("end", () => {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: randomUUID(),
            size: received,
            name: null,
            contentType: "application/octet-stream",
            createdAt: new Date().toISOString(),
          }),
        );
      });
    });
    app = await startGateway({
      db,
      audit: new FakeAudit(),
      storageUrl: discardingStorage,
      maxUploadBytes: 128 * 1024 * 1024,
    });
    const browser = new Browser(app);
    const ws = await browser.signUp("big@example.com");
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as AddressInfo).port;

    expect((globalThis as { gc?: () => void }).gc).toBeDefined();

    let sent = 0;
    const source = new Readable({
      read() {
        if (sent >= size) return this.push(null);
        const piece = Buffer.alloc(
          Math.min(64 * 1024, size - sent),
          sent % 251,
        );
        sent += piece.length;
        this.push(piece);
      },
    });
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: browser.ws(ws, "/files"),
          headers: {
            origin: DASHBOARD_ORIGIN,
            cookie: `${COOKIE}=${browser.cookie}`,
            "x-csrf-token": browser.csrf,
            "content-type": "application/octet-stream",
            "content-length": size,
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      source.pipe(req);
    });
    expect(status).toBe(201);
    expect(received).toBe(size);
    expect(samples).toBeGreaterThan(5);
    expect(highest - lowest).toBeLessThan(size / 2);
  }, 120_000);
});

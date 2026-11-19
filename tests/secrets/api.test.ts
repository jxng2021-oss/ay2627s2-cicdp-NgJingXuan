import type { PGlite } from "@electric-sql/pglite";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../services/secrets/src/db/client.js";
import {
  call,
  captureLogs,
  createTestDatabase,
  injectedValue,
  MAX_SECRET_BYTES,
  newTenant,
  startSecrets,
  storedValue,
  testKeyProvider,
} from "./helpers.js";

let db: Database;
let client: PGlite;
let app: FastifyInstance;
let tenant: string;

beforeEach(async () => {
  ({ db, client } = await createTestDatabase());
  app = await startSecrets({ db });
  tenant = newTenant();
});

const put = (name: string, value: string, tenantId = tenant) =>
  call(app, tenantId, "PUT", `/secrets/${name}`, value);
const get = (url: string, tenantId = tenant) => call(app, tenantId, "GET", url);
const injected = async (name: string, tenantId = tenant) =>
  (await injectedValue(app, tenantId, name)).value;

function expectError(
  response: LightMyRequestResponse,
  status: number,
  code: string,
) {
  expect(response.statusCode).toBe(status);
  const body = response.json<{ error: { code: string; requestId: string } }>();
  expect(body.error.code).toBe(code);
  expect(body.error.requestId).toBe(response.headers["x-request-id"]);
}

describe("saving and reading", () => {
  it("PUT creates version 1 (201), then adds versions (200); GET returns the latest's metadata, never the value", async () => {
    const first = await put("db-password", "one");
    const second = await put("db-password", "two");
    const latest = await get("/secrets/db-password");

    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ name: "db-password", version: 1 });
    expect(first.json()).not.toHaveProperty("value");
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ version: 2 });
    expect(latest.statusCode).toBe(200);
    expect(Object.keys(latest.json<object>()).sort()).toEqual([
      "createdAt",
      "name",
      "version",
    ]);
    expect(latest.json()).toMatchObject({ name: "db-password", version: 2 });
    expect(latest.body).not.toContain("two");
    expect(await injected("db-password")).toBe("two");
  });

  it("there is no reveal route any more", async () => {
    await put("x", "hidden");
    const reveal = await call(app, tenant, "POST", "/secrets/x/reveal");
    expectError(reveal, 404, "NOT_FOUND");
    expect(reveal.body).not.toContain("hidden");
  });

  it("GET ?version=N returns that version's metadata", async () => {
    await put("token", "v1");
    await put("token", "v2");
    await put("token", "v3");

    const one = await get("/secrets/token?version=1");
    expect(one.json()).toMatchObject({ name: "token", version: 1 });
    expect(one.body).not.toContain('"v1"');
    expect((await get("/secrets/token?version=2")).json()).toMatchObject({
      version: 2,
    });
    expectError(await get("/secrets/token?version=4"), 404, "NOT_FOUND");
    expect(await storedValue(db, tenant, "token", 1)).toBe("v1");
    expect(await storedValue(db, tenant, "token", 2)).toBe("v2");
  });

  it("POST /rotate saves the next version, and only for an existing secret", async () => {
    await put("api-key", "old");

    const rotated = await call(
      app,
      tenant,
      "POST",
      "/secrets/api-key/rotate",
      "new",
    );
    const missing = await call(
      app,
      tenant,
      "POST",
      "/secrets/nope/rotate",
      "x",
    );

    expect(rotated.statusCode).toBe(200);
    expect(rotated.json()).toMatchObject({ name: "api-key", version: 2 });
    expect(await injected("api-key")).toBe("new");
    expect(await storedValue(db, tenant, "api-key", 1)).toBe("old");
    expectError(missing, 404, "NOT_FOUND");
  });

  it("DELETE removes the secret and every encrypted version", async () => {
    await put("gone", "a");
    await put("gone", "b");

    const deleted = await call(app, tenant, "DELETE", "/secrets/gone");

    expect(deleted.statusCode).toBe(204);
    expectError(await get("/secrets/gone"), 404, "NOT_FOUND");
    expectError(await get("/secrets/gone?version=1"), 404, "NOT_FOUND");
    expectError(await get("/secrets/gone/versions"), 404, "NOT_FOUND");
    expectError(
      await call(app, tenant, "DELETE", "/secrets/gone"),
      404,
      "NOT_FOUND",
    );
    const rows = await client.query("select * from secret_versions");
    expect(rows.rows).toEqual([]);
    expect((await put("gone", "c")).json()).toMatchObject({ version: 1 });
  });

  it("sets Cache-Control: no-store on responses", async () => {
    const saved = await put("cached", "value");
    const read = await get("/secrets/cached");

    expect(saved.headers["cache-control"]).toBe("no-store");
    expect(read.headers["cache-control"]).toBe("no-store");
  });

  it("accepts values up to the limit and refuses bigger ones (413)", async () => {
    const atLimit = await put("big", "x".repeat(MAX_SECRET_BYTES));
    const overLimit = await put("big", "é".repeat(MAX_SECRET_BYTES / 2 + 1));

    expect(atLimit.statusCode).toBe(201);
    expectError(overLimit, 413, "PAYLOAD_TOO_LARGE");
  });

  it.each([
    "-starts-with-dash",
    ".hidden",
    "has space",
    "has%2Fslash",
    "x".repeat(129),
    "semi;colon",
    "%C3%A9",
  ])("refuses the name %j (400)", async (name) => {
    expectError(await put(name, "v"), 400, "BAD_REQUEST");
  });

  it.each([
    ["no body", undefined],
    ["a number value", { value: 42 }],
    ["an extra field", { value: "v", tenantId: newTenant() }],
  ])("refuses %s (400)", async (_case, payload) => {
    const response = await app.inject({
      method: "PUT",
      url: "/secrets/name",
      headers: { "x-tenant-id": tenant, "content-type": "application/json" },
      ...(payload === undefined ? {} : { payload }),
    });

    expectError(response, 400, "BAD_REQUEST");
  });

  it("refuses non-JSON bodies (415)", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/secrets/name",
      headers: { "x-tenant-id": tenant, "content-type": "text/plain" },
      payload: "value",
    });

    expectError(response, 415, "UNSUPPORTED_MEDIA_TYPE");
  });

  it.each([
    "/secrets/x?version=0",
    "/secrets/x?version=abc",
    "/secrets/x?version=1.5",
  ])("refuses an invalid version: %s (400)", async (url) => {
    expectError(await get(url), 400, "BAD_REQUEST");
  });

  it("requires X-Tenant-Id, and only accepts a UUID (400)", async () => {
    const missing = await app.inject({ method: "GET", url: "/secrets" });
    const invalid = await app.inject({
      method: "GET",
      url: "/secrets",
      headers: { "x-tenant-id": "tenant-a" },
    });

    expectError(missing, 400, "BAD_REQUEST");
    expectError(invalid, 400, "BAD_REQUEST");
  });
});

describe("lists", () => {
  it("GET /secrets lists names and metadata only, with pagination", async () => {
    for (const name of ["c", "a", "e", "b", "d"])
      await put(name, `value-of-${name}`);

    const first = await get("/secrets?limit=2");
    const firstBody = first.json<{
      secrets: { name: string }[];
      nextCursor: string;
    }>();
    const second = await get(`/secrets?limit=2&cursor=${firstBody.nextCursor}`);
    const secondBody = second.json<{
      secrets: { name: string }[];
      nextCursor: string;
    }>();
    const last = await get(`/secrets?limit=2&cursor=${secondBody.nextCursor}`);

    expect(firstBody.secrets.map((s) => s.name)).toEqual(["a", "b"]);
    expect(secondBody.secrets.map((s) => s.name)).toEqual(["c", "d"]);
    expect(last.json()).toMatchObject({
      secrets: [{ name: "e" }],
      nextCursor: null,
    });
    expect(Object.keys(firstBody.secrets[0] ?? {}).sort()).toEqual([
      "createdAt",
      "latestVersion",
      "name",
      "updatedAt",
    ]);
    for (const response of [first, second, last]) {
      expect(response.body).not.toContain("value-of-");
    }
  });

  it("uses a default page size of 20 and a maximum of 100", async () => {
    for (let i = 0; i < 21; i++)
      await put(`s${String(i).padStart(2, "0")}`, "v");

    const page = (await get("/secrets")).json<{
      secrets: unknown[];
      nextCursor: string;
    }>();

    expect(page.secrets).toHaveLength(20);
    expect(page.nextCursor).toBe("s19");
    expectError(await get("/secrets?limit=101"), 400, "BAD_REQUEST");
    expectError(await get("/secrets?limit=0"), 400, "BAD_REQUEST");
  });

  it("GET /secrets/:name/versions lists version metadata, newest first, with pagination", async () => {
    for (let i = 1; i <= 5; i++) await put("rotating", `value-${i}`);

    const first = await get("/secrets/rotating/versions?limit=3");
    const body = first.json<{
      versions: { version: number }[];
      nextCursor: string;
    }>();
    const rest = await get(
      `/secrets/rotating/versions?limit=3&cursor=${body.nextCursor}`,
    );

    expect(body.versions.map((v) => v.version)).toEqual([5, 4, 3]);
    expect(rest.json()).toMatchObject({
      name: "rotating",
      versions: [{ version: 2 }, { version: 1 }],
      nextCursor: null,
    });
    expect(first.body).not.toContain("value-");
    expect(rest.body).not.toContain("value-");
  });
});

describe("tenant isolation", () => {
  it("another tenant's secret is the same 404 as a missing one, on every route", async () => {
    const other = newTenant();
    await put("shared-name", "tenant A's value");

    const missingBody = (await get("/secrets/does-not-exist", other)).json<{
      error: { code: string; message: string };
    }>().error;
    const attempts = [
      await get("/secrets/shared-name", other),
      await get("/secrets/shared-name?version=1", other),
      await get("/secrets/shared-name/versions", other),
      await call(app, other, "POST", "/secrets/shared-name/rotate", "hijack"),
      await call(app, other, "DELETE", "/secrets/shared-name"),
    ];

    for (const response of attempts) {
      expectError(response, 404, "NOT_FOUND");
      const { code, message } = response.json<{
        error: { code: string; message: string };
      }>().error;
      expect({ code, message }).toEqual({
        code: missingBody.code,
        message: missingBody.message,
      });
      expect(response.body).not.toContain("tenant A's value");
    }
    expect((await get("/secrets", other)).json()).toEqual({
      secrets: [],
      nextCursor: null,
    });
    expect(await injected("shared-name")).toBe("tenant A's value");
    expect((await injectedValue(app, other, "shared-name")).status).toBe(404);
  });

  it("two tenants can use the same name independently", async () => {
    const other = newTenant();
    await put("db-password", "A's");
    await put("db-password", "B's", other);

    expect(await injected("db-password")).toBe("A's");
    expect(await injected("db-password", other)).toBe("B's");
  });

  it("gives each tenant its own key", async () => {
    await put("x", "v");
    await put("x", "v", newTenant());

    const keys = await client.query<{ tenant_id: string }>(
      "select tenant_id from tenant_keys",
    );

    expect(keys.rows).toHaveLength(2);
  });
});

describe("simultaneous requests", () => {
  it("simultaneous writes to one secret get different, consecutive versions", async () => {
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) => put("busy", `value-${i}`)),
    );

    const versions = responses.map(
      (r) => r.json<{ version: number }>().version,
    );
    expect(new Set(versions).size).toBe(20);
    expect(versions.sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect((await get("/secrets/busy")).json()).toMatchObject({ version: 20 });
  });

  it("a new tenant's first requests at the same moment create exactly one key", async () => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) => put(`first-${i}`, `value-${i}`)),
    );

    expect(responses.every((r) => r.statusCode === 201)).toBe(true);
    const keys = await client.query(
      "select * from tenant_keys where tenant_id = $1",
      [tenant],
    );
    expect(keys.rows).toHaveLength(1);
    for (let i = 0; i < 10; i++) {
      expect(await injected(`first-${i}`)).toBe(`value-${i}`);
    }
  });
});

describe("what is stored", () => {
  const VALUE = "correct-horse-battery-staple-1234";

  it("stores only ciphertext: the plain value is nowhere in the database", async () => {
    await put("stored", VALUE);
    await put("stored", VALUE);

    const dump = await client.query<Record<string, unknown>>(
      "select v.*, s.name from secret_versions v join secrets s on s.id = v.secret_id",
    );
    const keys = await client.query<Record<string, unknown>>(
      "select * from tenant_keys",
    );
    const everything = JSON.stringify(
      [dump.rows, keys.rows],
      (_k, v: unknown) =>
        v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : v,
    );

    expect(everything).not.toContain(VALUE);
    expect(dump.rows).toHaveLength(2);
    for (const row of dump.rows) {
      expect(row.format_version).toBe(1);
      expect(row.tenant_key_version).toBe(1);
      expect((row.nonce as Uint8Array).length).toBe(12);
      expect((row.auth_tag as Uint8Array).length).toBe(16);
      expect(
        Buffer.from(row.ciphertext as Uint8Array).toString("utf8"),
      ).not.toBe(VALUE);
    }
    const [one, two] = dump.rows;
    expect(Buffer.from(one?.ciphertext as Uint8Array)).not.toEqual(
      Buffer.from(two?.ciphertext as Uint8Array),
    );
    expect(keys.rows[0]).toMatchObject({
      format_version: 1,
      master_key_version: 1,
    });
  });

  it("never logs values or request bodies, even when requests fail", async () => {
    const logs = captureLogs();
    const logged = await startSecrets({ db, logStream: logs.stream });
    const failing = await startSecrets({
      db,
      keyProvider: testKeyProvider(9),
      logStream: logs.stream,
    });

    await call(logged, tenant, "PUT", "/secrets/logged", VALUE);
    await injectedValue(logged, tenant, "logged");
    await call(logged, tenant, "POST", "/secrets/logged/rotate", VALUE);
    await call(logged, tenant, "PUT", "/secrets/bad%20name", VALUE);
    await injectedValue(failing, tenant, "logged");

    expect(logs.text()).toContain("request completed");
    expect(logs.text()).toContain("decryption failed");
    expect(logs.text()).not.toContain(VALUE);
  });

  it("never echoes the value in error responses", async () => {
    const invalidJson = await app.inject({
      method: "PUT",
      url: "/secrets/x",
      headers: { "x-tenant-id": tenant, "content-type": "application/json" },
      payload: `{"value": "${VALUE}`,
    });
    const tooLarge = await put("x", VALUE + "x".repeat(MAX_SECRET_BYTES));
    const wrongType = await app.inject({
      method: "PUT",
      url: "/secrets/x",
      headers: { "x-tenant-id": tenant, "content-type": "application/json" },
      payload: { value: [VALUE] },
    });

    for (const response of [invalidJson, tooLarge, wrongType]) {
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.body).not.toContain(VALUE);
    }
  });
});

describe("damaged or moved data is refused with a generic error", () => {
  const decrypt = (name: string, tenantId = tenant, target = app) =>
    target.inject({
      method: "GET",
      url: `/internal/secrets/${name}`,
      headers: { "x-tenant-id": tenantId, "x-request-id": crypto.randomUUID() },
    });

  function expectGenericFailure(response: LightMyRequestResponse) {
    expectError(response, 500, "INTERNAL_ERROR");
    expect(response.json<{ error: { message: string } }>().error.message).toBe(
      "Something went wrong",
    );
    expect(response.body).not.toMatch(/decrypt|auth|tag|nonce|key/i);
  }

  it.each(["ciphertext", "nonce", "auth_tag"])(
    "a changed %s in the database",
    async (column) => {
      await put("tampered", "value");
      await client.query(
        `update secret_versions set ${column} = set_byte(${column}, 0, get_byte(${column}, 0) # 1)`,
      );

      expectGenericFailure(await decrypt("tampered"));
    },
  );

  it("a changed tenant key", async () => {
    await put("x", "value");
    await client.query(
      "update tenant_keys set ciphertext = set_byte(ciphertext, 0, get_byte(ciphertext, 0) # 1)",
    );

    expectGenericFailure(await decrypt("x"));
    expectGenericFailure(await put("y", "value"));
  });

  it("an encrypted value copied to another tenant", async () => {
    const other = newTenant();
    await put("a", "tenant A's value");
    await put("a", "B's own value", other);
    await client.query(`
      update secret_versions set nonce = src.nonce, ciphertext = src.ciphertext, auth_tag = src.auth_tag
      from (select v.* from secret_versions v join secrets s on s.id = v.secret_id where s.tenant_id = '${tenant}') src,
           secrets dst
      where secret_versions.secret_id = dst.id and dst.tenant_id = '${other}'`);

    expectGenericFailure(await decrypt("a", other));
  });

  it("an encrypted value copied to another name", async () => {
    await put("original", "the value");
    await put("copy", "something else");
    await client.query(`
      update secret_versions set nonce = src.nonce, ciphertext = src.ciphertext, auth_tag = src.auth_tag
      from (select v.* from secret_versions v join secrets s on s.id = v.secret_id where s.name = 'original') src,
           secrets dst
      where secret_versions.secret_id = dst.id and dst.name = 'copy'`);

    expectGenericFailure(await decrypt("copy"));
    expect(await injected("original")).toBe("the value");
  });

  it("an encrypted value copied to another version", async () => {
    await put("versioned", "version one");
    await put("versioned", "version two");
    await client.query(`
      update secret_versions set nonce = src.nonce, ciphertext = src.ciphertext, auth_tag = src.auth_tag
      from (select * from secret_versions where version = 1) src
      where secret_versions.version = 2`);

    expectGenericFailure(await decrypt("versioned"));
    expect(await storedValue(db, tenant, "versioned", 1)).toBe("version one");
  });

  it("a tenant key copied to another tenant", async () => {
    const other = newTenant();
    await put("a", "value", tenant);
    await put("b", "value", other);
    await client.query(`
      update tenant_keys set nonce = src.nonce, ciphertext = src.ciphertext, auth_tag = src.auth_tag
      from (select * from tenant_keys where tenant_id = '${tenant}') src
      where tenant_keys.tenant_id = '${other}'`);

    expectGenericFailure(await decrypt("b", other));
  });

  it("the wrong master key", async () => {
    await put("x", "value");
    const wrongKey = await startSecrets({
      db,
      keyProvider: testKeyProvider(2),
    });

    expectGenericFailure(await decrypt("x", tenant, wrongKey));
    expect((await call(wrongKey, tenant, "GET", "/secrets/x")).statusCode).toBe(
      200,
    );
    expect((await call(wrongKey, tenant, "GET", "/secrets")).statusCode).toBe(
      200,
    );
  });
});

describe("health", () => {
  it("/health and /ready need no tenant", async () => {
    const health = await app.inject({ method: "GET", url: "/health" });
    const ready = await app.inject({ method: "GET", url: "/ready" });

    expect(health.json()).toEqual({ status: "ok" });
    expect(ready.json()).toEqual({
      status: "ready",
      checks: { postgres: "up", seal: "unsealed" },
    });
  });

  it("/ready is 503 when Postgres is down", async () => {
    const down = await startSecrets({
      db: {
        execute: () => Promise.reject(new Error("down")),
      } as unknown as Database,
    });

    const ready = await down.inject({ method: "GET", url: "/ready" });

    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({
      status: "not_ready",
      reason: "postgres_down",
      checks: { postgres: "down", seal: "unsealed" },
    });
  });

  it("refuses traffic from outside the internal network (403)", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/secrets",
      headers: { "x-tenant-id": tenant },
      remoteAddress: "203.0.113.10",
    });

    expectError(response, 403, "FORBIDDEN");
  });
});

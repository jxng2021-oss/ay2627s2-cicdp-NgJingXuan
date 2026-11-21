import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { apiKeys, tenants } from "../../services/gateway/src/db/schema.js";
import {
  adminHeaders,
  captureLogs,
  createTenantWithKey,
  createTestDatabase,
  expectError,
  startFakeStorage,
  startGateway,
} from "./helpers.js";

async function setup() {
  const { db, client } = await createTestDatabase();
  let storageCalls = 0;
  const storageUrl = await startFakeStorage((_req, res) => {
    storageCalls += 1;
    res.end("ok");
  });
  const logs = captureLogs();
  const app = await startGateway({
    db,
    storageUrl,
    logger: { level: "trace", stream: logs.stream },
  });
  const tenant = await createTenantWithKey(app);
  const get = (authorization?: string) =>
    app.inject({
      method: "GET",
      url: "/v1/storage/files/00000000-0000-4000-8000-000000000000",
      headers: authorization === undefined ? {} : { authorization },
    });
  return {
    app,
    db,
    client,
    logs,
    tenant,
    get,
    storageCalls: () => storageCalls,
  };
}

describe("API key authentication", () => {
  it("lets a valid key through", async () => {
    const { get, tenant, storageCalls } = await setup();

    const response = await get(`Bearer ${tenant.key}`);

    expect(response.statusCode).toBe(200);
    expect(storageCalls()).toBe(1);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["not a bearer token", "Basic dXNlcjpwYXNz"],
    ["malformed", "Bearer not-a-key"],
    [
      "unknown",
      "Bearer sk_test_0123456789abcdef_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ],
  ])("rejects a %s key with the generic 401", async (_case, authorization) => {
    const { get, storageCalls } = await setup();

    const response = await get(authorization);

    expectError(response, 401, "UNAUTHORIZED", "A valid API key is required");
    expect(response.headers["www-authenticate"]).toBe("Bearer");
    expect(storageCalls()).toBe(0);
  });

  it("rejects a key with the right ID but the wrong secret, with the same 401", async () => {
    const { get, tenant } = await setup();
    const wrong =
      tenant.key.slice(0, -4) + (tenant.key.endsWith("AAAA") ? "BBBB" : "AAAA");

    const response = await get(`Bearer ${wrong}`);

    expectError(response, 401, "UNAUTHORIZED", "A valid API key is required");
  });

  it("rejects a revoked key with the same 401", async () => {
    const { app, get, tenant, storageCalls } = await setup();
    await app.inject({
      method: "DELETE",
      url: `/admin/tenants/${tenant.tenantId}/api-keys/${tenant.keyId}`,
      headers: adminHeaders,
    });

    const response = await get(`Bearer ${tenant.key}`);

    expectError(response, 401, "UNAUTHORIZED", "A valid API key is required");
    expect(storageCalls()).toBe(0);
  });

  it("returns 403 for a valid key of a suspended tenant", async () => {
    const { db, get, tenant, storageCalls } = await setup();
    await db
      .update(tenants)
      .set({ status: "suspended" })
      .where(eq(tenants.id, tenant.tenantId));

    const response = await get(`Bearer ${tenant.key}`);

    expectError(response, 403, "FORBIDDEN", "This tenant is suspended");
    expect(storageCalls()).toBe(0);
  });

  it("still returns 401 (not 403) for a bad key of a suspended tenant", async () => {
    const { db, get, tenant } = await setup();
    await db
      .update(tenants)
      .set({ status: "suspended" })
      .where(eq(tenants.id, tenant.tenantId));

    const response = await get(`Bearer ${tenant.key.slice(0, -1)}x`);

    expect(response.statusCode).toBe(401);
  });

  it("records when a key was last used", async () => {
    const { db, get, tenant } = await setup();

    await get(`Bearer ${tenant.key}`);

    const [row] = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, tenant.keyId));
    expect(row?.lastUsedAt).toBeInstanceOf(Date);
  });

  it("never stores the key in plain text", async () => {
    const { client, tenant } = await setup();

    const tables = await client.query<{ schema: string; name: string }>(
      `select table_schema as schema, table_name as name
         from information_schema.tables
        where table_schema not in ('pg_catalog', 'information_schema')
          and table_type = 'BASE TABLE'`,
    );
    const rows: string[] = [];
    for (const { schema, name } of tables.rows) {
      const result = await client.query<{ row: string }>(
        `select row_to_json(t)::text as row from "${schema}"."${name}" t`,
      );
      rows.push(...result.rows.map((r) => r.row));
    }
    const everything = rows.join("\n");

    expect(everything).toContain(tenant.keyId);
    expect(everything).not.toContain(tenant.key);
    expect(everything).not.toContain(tenant.key.slice(-43));
  });

  it("never writes keys or the admin token to the logs", async () => {
    const { app, get, logs, tenant } = await setup();

    await get(`Bearer ${tenant.key}`);
    await get(`Bearer ${tenant.key}x`);
    await app.inject({
      method: "GET",
      url: `/admin/tenants/${tenant.tenantId}/api-keys`,
      headers: adminHeaders,
    });

    const text = logs.text();
    expect(text).toContain("request completed");
    expect(text).not.toContain(tenant.key);
    expect(text).not.toContain(tenant.key.slice(-43));
    expect(text).not.toContain(
      adminHeaders.authorization.slice("Bearer ".length),
    );
  });
});

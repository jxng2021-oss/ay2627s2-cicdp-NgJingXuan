import { describe, expect, it } from "vitest";
import {
  ADMIN_TOKEN,
  adminHeaders,
  createTenantWithKey,
  createTestDatabase,
  expectError,
  startGateway,
} from "./helpers.js";

async function setup() {
  const { db } = await createTestDatabase();
  return startGateway({ db });
}

const KEY_PATTERN = /^sk_test_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/;

describe("admin API", () => {
  it.each([
    ["no token", {}],
    ["a wrong token", { authorization: "Bearer wrong-token" }],
    [
      "the right token with one character changed",
      { authorization: `Bearer ${ADMIN_TOKEN.slice(0, -1)}X` },
    ],
    ["the token without 'Bearer'", { authorization: ADMIN_TOKEN }],
  ])("rejects %s with 401", async (_case, headers) => {
    const app = await setup();

    const response = await app.inject({
      method: "POST",
      url: "/admin/tenants",
      headers,
      payload: { name: "Acme" },
    });

    expectError(
      response,
      401,
      "UNAUTHORIZED",
      "A valid admin token is required",
    );
  });

  it("protects every admin route", async () => {
    const app = await setup();
    const { tenantId, keyId } = await createTenantWithKey(app);

    const responses = await Promise.all([
      app.inject({
        method: "POST",
        url: "/admin/tenants",
        payload: { name: "x" },
      }),
      app.inject({
        method: "POST",
        url: `/admin/tenants/${tenantId}/api-keys`,
        payload: { name: "x" },
      }),
      app.inject({ method: "GET", url: `/admin/tenants/${tenantId}/api-keys` }),
      app.inject({
        method: "DELETE",
        url: `/admin/tenants/${tenantId}/api-keys/${keyId}`,
      }),
    ]);

    expect(responses.map((r) => r.statusCode)).toEqual([401, 401, 401, 401]);
  });

  it("creates a tenant", async () => {
    const app = await setup();

    const response = await app.inject({
      method: "POST",
      url: "/admin/tenants",
      headers: adminHeaders,
      payload: { name: "Acme" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ name: "Acme", status: "active" });
  });

  it("validates input", async () => {
    const app = await setup();

    const responses = await Promise.all([
      app.inject({
        method: "POST",
        url: "/admin/tenants",
        headers: adminHeaders,
        payload: {},
      }),
      app.inject({
        method: "POST",
        url: "/admin/tenants",
        headers: adminHeaders,
        payload: { name: "" },
      }),
      app.inject({
        method: "GET",
        url: "/admin/tenants/not-a-uuid/api-keys",
        headers: adminHeaders,
      }),
    ]);

    expect(responses.map((r) => r.statusCode)).toEqual([400, 400, 400]);
  });

  it("creates a key and shows it in full only once", async () => {
    const app = await setup();
    const { tenantId, key } = await createTenantWithKey(app);

    expect(key).toMatch(KEY_PATTERN);

    const list = await app.inject({
      method: "GET",
      url: `/admin/tenants/${tenantId}/api-keys`,
      headers: adminHeaders,
    });
    expect(list.statusCode).toBe(200);
    const { apiKeys } = list.json<{ apiKeys: Record<string, unknown>[] }>();
    expect(apiKeys).toHaveLength(1);
    expect(apiKeys[0]).toMatchObject({
      name: "Acme key",
      status: "active",
      prefix: key.slice(0, 24),
    });
    expect(apiKeys[0]).not.toHaveProperty("key");
    expect(apiKeys[0]).not.toHaveProperty("secretHash");
    expect(list.body).not.toContain(key.slice(-43));
  });

  it("gives every key a different value", async () => {
    const app = await setup();
    const first = await createTenantWithKey(app, "A");
    const second = await createTenantWithKey(app, "B");

    expect(first.key).not.toBe(second.key);
  });

  it("revokes a key, and revoking again is harmless", async () => {
    const app = await setup();
    const { tenantId, keyId } = await createTenantWithKey(app);
    const revoke = () =>
      app.inject({
        method: "DELETE",
        url: `/admin/tenants/${tenantId}/api-keys/${keyId}`,
        headers: adminHeaders,
      });

    expect((await revoke()).statusCode).toBe(204);
    expect((await revoke()).statusCode).toBe(204);

    const list = await app.inject({
      method: "GET",
      url: `/admin/tenants/${tenantId}/api-keys`,
      headers: adminHeaders,
    });
    expect(
      list.json<{ apiKeys: { status: string; revokedAt: string | null }[] }>()
        .apiKeys[0],
    ).toMatchObject({
      status: "revoked",
      revokedAt: expect.any(String) as unknown,
    });
  });

  it("returns 404 for unknown tenants and keys, including another tenant's key", async () => {
    const app = await setup();
    const a = await createTenantWithKey(app, "A");
    const b = await createTenantWithKey(app, "B");
    const unknown = "00000000-0000-4000-8000-000000000000";

    const responses = await Promise.all([
      app.inject({
        method: "POST",
        url: `/admin/tenants/${unknown}/api-keys`,
        headers: adminHeaders,
        payload: { name: "x" },
      }),
      app.inject({
        method: "GET",
        url: `/admin/tenants/${unknown}/api-keys`,
        headers: adminHeaders,
      }),
      app.inject({
        method: "DELETE",
        url: `/admin/tenants/${a.tenantId}/api-keys/${unknown}`,
        headers: adminHeaders,
      }),
      app.inject({
        method: "DELETE",
        url: `/admin/tenants/${a.tenantId}/api-keys/${b.keyId}`,
        headers: adminHeaders,
      }),
    ]);

    expect(responses.map((r) => r.statusCode)).toEqual([404, 404, 404, 404]);
  });
});

import { describe, expect, it } from "vitest";
import { signingKeys } from "../../services/identity/src/db/schema.js";
import {
  call,
  createPool,
  newTenant,
  PUBLIC_BASE_URL,
  signUp,
  startIdentity,
} from "./helpers.js";

describe("user pools", () => {
  it("creates a pool with its issuer, JWKS address and default settings", async () => {
    const { app, audit } = await startIdentity();
    const tenant = newTenant();

    const response = await call(app, tenant, "POST", "/pools", {
      name: "Shop customers",
    });

    expect(response.statusCode).toBe(201);
    const pool = response.json<Record<string, unknown>>();
    expect(pool).toMatchObject({
      name: "Shop customers",
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 2_592_000,
      minPasswordLength: 12,
      userCount: 0,
      issuer: `${PUBLIC_BASE_URL}/v1/user-pools/${String(pool.id)}`,
      jwksUrl: `${PUBLIC_BASE_URL}/v1/user-pools/${String(pool.id)}/jwks.json`,
    });
    expect(audit.events.map((e) => [e.action, e.resourceId])).toEqual([
      ["user_pool.created", pool.id],
    ]);
  });

  it("lists, reads, renames and deletes a tenant's pools; another tenant gets 404", async () => {
    const { app } = await startIdentity();
    const tenant = newTenant();
    const other = newTenant();
    const pool = await createPool(app, tenant, { name: "B pool" });
    await createPool(app, tenant, { name: "A pool" });
    await signUp(app, tenant, pool, "one@example.com");

    const list = await call(app, tenant, "GET", "/pools");
    expect(
      list.json<{ pools: { name: string; userCount: number }[] }>().pools,
    ).toMatchObject([
      { name: "A pool", userCount: 0 },
      { name: "B pool", userCount: 1 },
    ]);
    expect((await call(app, other, "GET", "/pools")).json()).toEqual({
      pools: [],
    });
    for (const [method, body] of [
      ["GET", undefined],
      ["PATCH", { name: "Mine now" }],
      ["DELETE", undefined],
    ] as const) {
      const response = await call(app, other, method, `/pools/${pool}`, body);
      expect(response.statusCode).toBe(404);
    }

    const renamed = await call(app, tenant, "PATCH", `/pools/${pool}`, {
      name: "Renamed",
      accessTokenTtlSeconds: 300,
    });
    expect(renamed.json()).toMatchObject({
      name: "Renamed",
      accessTokenTtlSeconds: 300,
    });
    expect(
      (await call(app, tenant, "DELETE", `/pools/${pool}`)).statusCode,
    ).toBe(204);
    expect((await call(app, tenant, "GET", `/pools/${pool}`)).statusCode).toBe(
      404,
    );
  });

  it("refuses a duplicate name (409) and bad settings (400)", async () => {
    const { app } = await startIdentity();
    const tenant = newTenant();
    await createPool(app, tenant, { name: "Customers" });

    expect(
      (await call(app, tenant, "POST", "/pools", { name: "Customers" }))
        .statusCode,
    ).toBe(409);
    expect(
      (await call(app, newTenant(), "POST", "/pools", { name: "Customers" }))
        .statusCode,
    ).toBe(201);
    for (const body of [
      { name: "" },
      { name: "<script>" },
      { name: "x", accessTokenTtlSeconds: 5 },
      { name: "x", minPasswordLength: 8 },
      { name: "x", extra: true },
    ]) {
      expect((await call(app, tenant, "POST", "/pools", body)).statusCode).toBe(
        400,
      );
    }
  });

  it("can't create a pool while the vault is sealed (503), and saves nothing", async () => {
    const { app, vault } = await startIdentity();
    const tenant = newTenant();
    vault.sealed = true;

    const response = await call(app, tenant, "POST", "/pools", {
      name: "Later",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "SECRETS_SEALED" },
    });
    expect((await call(app, tenant, "GET", "/pools")).json()).toEqual({
      pools: [],
    });
  });

  it("refuses a change it can't record (503), and keeps nothing", async () => {
    const { app, audit } = await startIdentity();
    const tenant = newTenant();
    audit.down = true;

    expect(
      (await call(app, tenant, "POST", "/pools", { name: "X" })).statusCode,
    ).toBe(503);
    audit.down = false;
    expect((await call(app, tenant, "GET", "/pools")).json()).toEqual({
      pools: [],
    });
  });

  it("publishes a pool's public key (JWKS) without a tenant, never the private key", async () => {
    const { app, db } = await startIdentity();
    const pool = await createPool(app, newTenant());

    const response = await app.inject({
      method: "GET",
      url: `/public/pools/${pool}/jwks`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=300");
    const { keys } = response.json<{ keys: Record<string, string>[] }>();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({
      kty: "EC",
      crv: "P-256",
      alg: "ES256",
      use: "sig",
    });
    expect(keys[0]).not.toHaveProperty("d");
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/public/pools/${crypto.randomUUID()}/jwks`,
        })
      ).statusCode,
    ).toBe(404);

    const stored = JSON.stringify(await db.select().from(signingKeys));
    expect(stored).not.toContain('"d"');
  });

  it("deletes every pool of a tenant (crypto-shredding the workspace)", async () => {
    const { app } = await startIdentity();
    const tenant = newTenant();
    const other = newTenant();
    await createPool(app, tenant, { name: "One" });
    await createPool(app, tenant, { name: "Two" });
    await createPool(app, other, { name: "Theirs" });

    expect((await call(app, tenant, "DELETE", "/tenant")).statusCode).toBe(204);
    expect((await call(app, tenant, "DELETE", "/tenant")).statusCode).toBe(204);

    expect((await call(app, tenant, "GET", "/pools")).json()).toEqual({
      pools: [],
    });
    expect(
      (await call(app, other, "GET", "/pools")).json<{ pools: unknown[] }>()
        .pools,
    ).toHaveLength(1);
  });

  it("only accepts a valid X-Tenant-Id", async () => {
    const { app } = await startIdentity();
    const response = await app.inject({ method: "GET", url: "/pools" });
    expect(response.statusCode).toBe(400);
  });
});

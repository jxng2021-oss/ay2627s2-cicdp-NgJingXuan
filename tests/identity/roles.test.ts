import { describe, expect, it } from "vitest";
import {
  MAX_ROLES_PER_POOL,
  MAX_ROLES_PER_USER,
} from "../../services/identity/src/app.js";
import { verifyJwt } from "../../services/identity/src/signing.js";
import {
  call,
  createPool,
  newTenant,
  PASSWORD,
  signUp,
  startIdentity,
  type TestService,
  type Tokens,
} from "./helpers.js";

async function setup(service: TestService) {
  const tenant = newTenant();
  const pool = await createPool(service.app, tenant, { name: "Shop" });
  const user = await signUp(service.app, tenant, pool, "ada@example.com");
  const api = (
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ) => call(service.app, tenant, method, `/pools/${pool}${path}`, body);
  return { tenant, pool, user, api };
}

describe("roles", () => {
  it("creates, lists, changes and deletes roles, each audited", async () => {
    const service = await startIdentity();
    const { api } = await setup(service);

    const created = await api("POST", "/roles", {
      name: "support",
      description: "Answers customers",
      permissions: ["orders:read", "orders:refund"],
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      name: "support",
      permissions: ["orders:read", "orders:refund"],
      userCount: 0,
    });
    await api("POST", "/roles", { name: "admin", permissions: ["*"] });

    const list = await api("GET", "/roles");
    expect(
      list.json<{ roles: { name: string }[] }>().roles.map((r) => r.name),
    ).toEqual(["admin", "support"]);

    const changed = await api("PATCH", "/roles/support", {
      permissions: ["orders:*"],
    });
    expect(changed.json()).toMatchObject({
      name: "support",
      description: "Answers customers",
      permissions: ["orders:*"],
    });

    expect((await api("DELETE", "/roles/support")).statusCode).toBe(204);
    expect((await api("GET", "/roles/support")).statusCode).toBe(404);
    expect(service.audit.events.map((e) => e.action)).toEqual(
      expect.arrayContaining([
        "pool_role.created",
        "pool_role.updated",
        "pool_role.deleted",
      ]),
    );
  });

  it("refuses a taken name, bad names and permissions, and too many roles", async () => {
    const service = await startIdentity();
    const { api } = await setup(service);
    await api("POST", "/roles", { name: "admin", permissions: [] });

    expect(
      (await api("POST", "/roles", { name: "admin", permissions: [] }))
        .statusCode,
    ).toBe(409);
    for (const body of [
      { name: "Admin", permissions: [] },
      { name: "has space", permissions: [] },
      { name: "ok", permissions: ["<script>"] },
      { name: "ok", permissions: ["a", "a"] },
      { name: "ok", permissions: ["orders*"] },
      { name: "ok" },
    ]) {
      expect((await api("POST", "/roles", body)).statusCode).toBe(400);
    }

    for (let i = 1; i < MAX_ROLES_PER_POOL; i++) {
      await api("POST", "/roles", { name: `role-${i}`, permissions: [] });
    }
    expect(
      (await api("POST", "/roles", { name: "one-too-many", permissions: [] }))
        .statusCode,
    ).toBe(409);
  });

  it("gives and takes roles (safe to repeat), shown on the user", async () => {
    const service = await startIdentity();
    const { api, user } = await setup(service);
    await api("POST", "/roles", {
      name: "editor",
      permissions: ["posts:write"],
    });

    for (let i = 0; i < 2; i++) {
      const given = await api("PUT", `/users/${user}/roles/editor`);
      expect(given.statusCode).toBe(200);
      expect(given.json()).toMatchObject({ id: user, roles: ["editor"] });
    }
    expect((await api("GET", `/users/${user}`)).json()).toMatchObject({
      roles: ["editor"],
    });
    expect((await api("GET", "/users")).json()).toMatchObject({
      users: [{ id: user, roles: ["editor"] }],
    });
    expect((await api("GET", "/roles/editor")).json()).toMatchObject({
      userCount: 1,
    });
    expect(
      service.audit.events.filter((e) => e.action === "pool_user.role_added"),
    ).toHaveLength(1);

    const taken = await api("DELETE", `/users/${user}/roles/editor`);
    expect(taken.json()).toMatchObject({ roles: [] });
    expect(
      (await api("DELETE", `/users/${user}/roles/editor`)).statusCode,
    ).toBe(200);
    expect(
      service.audit.events.filter((e) => e.action === "pool_user.role_removed"),
    ).toHaveLength(1);
  });

  it("deleting a role takes it from its users", async () => {
    const service = await startIdentity();
    const { api, user } = await setup(service);
    await api("POST", "/roles", { name: "editor", permissions: [] });
    await api("PUT", `/users/${user}/roles/editor`);

    await api("DELETE", "/roles/editor");

    expect((await api("GET", `/users/${user}`)).json()).toMatchObject({
      roles: [],
    });
  });

  it("a user can have at most the limit of roles", async () => {
    const service = await startIdentity();
    const { api, user } = await setup(service);
    for (let i = 0; i <= MAX_ROLES_PER_USER; i++) {
      await api("POST", "/roles", { name: `r${i}`, permissions: [] });
    }
    for (let i = 0; i < MAX_ROLES_PER_USER; i++) {
      expect((await api("PUT", `/users/${user}/roles/r${i}`)).statusCode).toBe(
        200,
      );
    }
    expect(
      (await api("PUT", `/users/${user}/roles/r${MAX_ROLES_PER_USER}`))
        .statusCode,
    ).toBe(409);
    expect((await api("PUT", `/users/${user}/roles/r0`)).statusCode).toBe(200);
  });

  it("puts the user's roles and their permissions into the access token", async () => {
    const service = await startIdentity();
    const { api, user, pool } = await setup(service);
    await api("POST", "/roles", {
      name: "support",
      permissions: ["orders:read", "orders:refund"],
    });
    await api("POST", "/roles", {
      name: "editor",
      permissions: ["posts:write", "orders:read"],
    });
    await api("PUT", `/users/${user}/roles/support`);
    await api("PUT", `/users/${user}/roles/editor`);

    const login = await api("POST", "/sessions", {
      email: "ada@example.com",
      password: PASSWORD,
    });
    const tokens = login.json<Tokens>();
    const claims = verifyJwt(
      tokens.accessToken,
      await publicKeys(service, pool),
    );
    expect(claims).toMatchObject({
      roles: ["editor", "support"],
      permissions: ["orders:read", "orders:refund", "posts:write"],
    });
    expect(tokens.user).toMatchObject({ roles: ["editor", "support"] });

    await api("DELETE", `/users/${user}/roles/support`);
    const refreshed = (
      await api("POST", "/sessions/refresh", {
        refreshToken: tokens.refreshToken,
      })
    ).json<Tokens>();
    expect(
      verifyJwt(refreshed.accessToken, await publicKeys(service, pool)),
    ).toMatchObject({
      roles: ["editor"],
      permissions: ["orders:read", "posts:write"],
    });
  });

  it("another tenant's pool, user or role is a 404", async () => {
    const service = await startIdentity();
    const { pool, user, api } = await setup(service);
    await api("POST", "/roles", { name: "editor", permissions: [] });
    const other = newTenant();

    for (const [method, path] of [
      ["GET", `/pools/${pool}/roles`],
      ["GET", `/pools/${pool}/roles/editor`],
      ["DELETE", `/pools/${pool}/roles/editor`],
      ["PUT", `/pools/${pool}/users/${user}/roles/editor`],
    ] as const) {
      expect((await call(service.app, other, method, path)).statusCode).toBe(
        404,
      );
    }
    expect((await api("PUT", `/users/${user}/roles/missing`)).statusCode).toBe(
      404,
    );
  });

  it("refuses a role change it can't record", async () => {
    const service = await startIdentity();
    const { api } = await setup(service);
    service.audit.down = true;
    expect(
      (await api("POST", "/roles", { name: "editor", permissions: [] }))
        .statusCode,
    ).toBe(503);
    service.audit.down = false;
    expect((await api("GET", "/roles")).json()).toEqual({ roles: [] });
  });
});

async function publicKeys(
  service: TestService,
  pool: string,
): Promise<Record<string, string>[]> {
  const response = await service.app.inject({
    method: "GET",
    url: `/public/pools/${pool}/jwks`,
  });
  return response.json<{ keys: Record<string, string>[] }>().keys;
}

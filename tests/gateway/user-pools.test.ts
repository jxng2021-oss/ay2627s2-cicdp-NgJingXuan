import type { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { insertMembership } from "../../services/gateway/src/models/membership.model.js";
import type { Database } from "../../services/gateway/src/db/client.js";
import { expectPublicContract } from "./contract-helpers.js";
import { Browser, fakeAuditEvents, fakeIdentity } from "./dashboard-helpers.js";
import {
  createTestDatabase,
  createTenantWithKey,
  expectError,
  FakeAudit,
  startGateway,
} from "./helpers.js";

let db: Database;
let app: FastifyInstance;
let identity: Awaited<ReturnType<typeof fakeIdentity>>;
let auditService: Awaited<ReturnType<typeof fakeAuditEvents>>;

beforeEach(async () => {
  ({ db } = await createTestDatabase());
  identity = await fakeIdentity();
  auditService = await fakeAuditEvents();
  app = await startGateway({
    db,
    audit: new FakeAudit(),
    identityUrl: identity.url,
    auditUrl: auditService.url,
  });
});

async function workspaceWithPool() {
  const owner = new Browser(app);
  const workspace = await owner.signUp("owner@example.com", "Shop");
  const created = await owner.request(
    "POST",
    owner.ws(workspace, "/user-pools"),
    { body: { name: "Customers" } },
  );
  expect(created.statusCode).toBe(201);
  return { owner, workspace, pool: created.json<{ id: string }>().id };
}

describe("/v1/user-pools (apps, with an API key)", () => {
  it("forwards only the validated fields, with the tenant from the key", async () => {
    const { workspace, pool } = await workspaceWithPool();
    const { key } = await createTenantWithKey(app, "other");

    const owner = new Browser(app);
    await owner.login("owner@example.com");
    const apiKey = (
      await owner.request("POST", owner.ws(workspace, "/api-keys"), {
        body: { name: "app" },
      })
    ).json<{ key: string }>().key;

    const signUp = await app.inject({
      method: "POST",
      url: `/v1/user-pools/${pool}/users`,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "x-tenant-id": "00000000-0000-4000-8000-000000000000",
        cookie: "scp_session=x",
      },
      payload: {
        email: "ada@example.com",
        password: "a-long-enough-password",
        attributes: { plan: "pro" },
      },
    });
    expect(signUp.statusCode).toBe(201);
    expect(signUp.headers["cache-control"]).toBe("no-store");
    expectPublicContract("POST", `/v1/user-pools/${pool}/users`, signUp);

    const sent = identity.requests.at(-1)!;
    expect(sent.headers["x-tenant-id"]).toBe(workspace);
    expect(sent.headers.authorization).toBeUndefined();
    expect(sent.headers.cookie).toBeUndefined();
    expect(JSON.parse(sent.body.toString())).toEqual({
      email: "ada@example.com",
      password: "a-long-enough-password",
      attributes: { plan: "pro" },
    });

    const elsewhere = await app.inject({
      method: "POST",
      url: `/v1/user-pools/${pool}/sessions`,
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      payload: { email: "ada@example.com", password: "a-long-enough-password" },
    });
    expectError(elsewhere, 404, "NOT_FOUND");
    expect(identity.problems).toEqual([]);
  });

  it("refuses bad input before the identity service, and needs a key", async () => {
    const { pool } = await workspaceWithPool();
    const { key } = await createTenantWithKey(app, "t");
    const before = identity.requests.length;
    const post = (url: string, payload: unknown, auth = `Bearer ${key}`) =>
      app.inject({
        method: "POST",
        url,
        headers: { authorization: auth, "content-type": "application/json" },
        payload: payload as object,
      });

    expectError(
      await post(`/v1/user-pools/${pool}/users`, {
        email: "x@y.z",
        password: "p",
        role: "admin",
      }),
      400,
      "BAD_REQUEST",
    );
    expectError(
      await post(`/v1/user-pools/${pool}/sessions/refresh`, {
        refreshToken: "short",
      }),
      400,
      "BAD_REQUEST",
    );
    expectError(
      await post("/v1/user-pools/not-a-uuid/sessions", {
        email: "a@b.co",
        password: "p",
      }),
      400,
      "BAD_REQUEST",
    );
    expectError(
      await post(
        `/v1/user-pools/${pool}/sessions`,
        { email: "a@b.co", password: "p" },
        "",
      ),
      401,
      "UNAUTHORIZED",
    );
    expect(identity.requests.length).toBe(before);
  });

  it("serves a pool's public keys without any key", async () => {
    const { pool } = await workspaceWithPool();

    const response = await app.inject({
      method: "GET",
      url: `/v1/user-pools/${pool}/jwks.json`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=300");
    expectPublicContract("GET", `/v1/user-pools/${pool}/jwks.json`, response);
    const sent = identity.requests.at(-1)!;
    expect(sent.url).toBe(`/public/pools/${pool}/jwks`);
    expect(sent.headers["x-tenant-id"]).toBeUndefined();
  });
});

describe("user pools in the dashboard", () => {
  it("owners create and delete pools and reset passwords; members only view", async () => {
    const { owner, workspace, pool } = await workspaceWithPool();
    const member = new Browser(app);
    await member.signUp("member@example.com", "Member's own");
    const me = await member.request("GET", "/dashboard/v1/auth/me");
    await insertMembership(db, {
      userId: me.json<{ user: { id: string } }>().user.id,
      tenantId: workspace,
      role: "member",
    });
    const user = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";

    for (const path of [
      "/user-pools",
      `/user-pools/${pool}`,
      `/user-pools/${pool}/users`,
    ]) {
      expect(
        (await member.request("GET", member.ws(workspace, path))).statusCode,
      ).toBe(200);
    }
    for (const [method, path, body] of [
      ["POST", "/user-pools", { name: "Mine" }],
      ["PATCH", `/user-pools/${pool}`, { name: "Renamed" }],
      ["DELETE", `/user-pools/${pool}`, undefined],
      ["PATCH", `/user-pools/${pool}/users/${user}`, { status: "disabled" }],
      ["DELETE", `/user-pools/${pool}/users/${user}`, undefined],
      ["POST", `/user-pools/${pool}/users/${user}/reset-password`, undefined],
      ["POST", `/user-pools/${pool}/users/${user}/unlock`, undefined],
    ] as const) {
      expectError(
        await member.request(
          method,
          member.ws(workspace, path),
          body ? { body } : {},
        ),
        403,
        "FORBIDDEN",
      );
    }

    const reset = await owner.request(
      "POST",
      owner.ws(workspace, `/user-pools/${pool}/users/${user}/reset-password`),
    );
    expect(reset.json()).toMatchObject({ passwordResetRequired: true });
    expect(reset.body).not.toContain("temporaryPassword");
    const unlocked = await owner.request(
      "POST",
      owner.ws(workspace, `/user-pools/${pool}/users/${user}/unlock`),
    );
    expect(unlocked.statusCode).toBe(200);
    expect(unlocked.json()).toMatchObject({ locked: false });
    expect(identity.requests.at(-1)!.url).toBe(
      `/pools/${pool}/users/${user}/unlock`,
    );
    expect(
      (
        await owner.request(
          "DELETE",
          owner.ws(workspace, `/user-pools/${pool}`),
        )
      ).statusCode,
    ).toBe(204);
    expect(identity.problems).toEqual([]);
  });

  it("members read a pool's own audit log; another workspace's pool is a 404", async () => {
    const { owner, workspace, pool } = await workspaceWithPool();
    const member = new Browser(app);
    await member.signUp("member@example.com", "Member's own");
    const me = await member.request("GET", "/dashboard/v1/auth/me");
    await insertMembership(db, {
      userId: me.json<{ user: { id: string } }>().user.id,
      tenantId: workspace,
      role: "member",
    });

    const read = await member.request(
      "GET",
      member.ws(
        workspace,
        `/user-pools/${pool}/audit-events?limit=10&action=pool_user.unlocked`,
      ),
    );
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({ events: [], nextCursor: null });
    const sent = auditService.requests.at(-1)!;
    expect(sent.url).toBe(
      `/pools/${pool}/events?limit=10&action=pool_user.unlocked`,
    );
    expect(sent.headers["x-tenant-id"]).toBe(workspace);

    const several = await member.request(
      "GET",
      member.ws(
        workspace,
        `/user-pools/${pool}/audit-events?action=pool_user.login_failed&action=pool_role.created&outcome=success&limit=50`,
      ),
    );
    expect(several.statusCode).toBe(200);
    expect(auditService.requests.at(-1)!.url).toBe(
      `/pools/${pool}/events?action=pool_user.login_failed&action=pool_role.created&outcome=success&limit=50`,
    );
    expectError(
      await member.request(
        "GET",
        member.ws(
          workspace,
          `/user-pools/${pool}/audit-events?action=pool_user.login_failed&action=secret.read`,
        ),
      ),
      400,
      "BAD_REQUEST",
    );

    const stranger = new Browser(app);
    const theirs = await stranger.signUp("stranger@example.com", "Theirs");
    expectError(
      await stranger.request(
        "GET",
        stranger.ws(theirs, `/user-pools/${pool}/audit-events`),
      ),
      404,
      "NOT_FOUND",
    );
    expectError(
      await owner.request(
        "GET",
        owner.ws(
          workspace,
          "/user-pools/6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b/audit-events",
        ),
      ),
      404,
      "NOT_FOUND",
    );
    expect(auditService.problems).toEqual([]);
  });

  it("another workspace's member can't reach the pool (the same 404 as a missing workspace)", async () => {
    const { workspace, pool } = await workspaceWithPool();
    const stranger = new Browser(app);
    await stranger.signUp("stranger@example.com", "Elsewhere");
    expectError(
      await stranger.request(
        "GET",
        stranger.ws(workspace, `/user-pools/${pool}`),
      ),
      404,
      "NOT_FOUND",
    );
  });
});

describe("user pool roles (docs/decisions/0030)", () => {
  async function appKey(workspace: string) {
    const owner = new Browser(app);
    await owner.login("owner@example.com");
    return (
      await owner.request("POST", owner.ws(workspace, "/api-keys"), {
        body: { name: "app" },
      })
    ).json<{ key: string }>().key;
  }

  it("an app manages roles and gives them to users, with only valid values forwarded", async () => {
    const { workspace, pool } = await workspaceWithPool();
    const key = await appKey(workspace);
    const v1 = (
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
      path: string,
      payload?: object,
    ) =>
      app.inject({
        method,
        url: `/v1/user-pools/${pool}${path}`,
        headers: {
          authorization: `Bearer ${key}`,
          ...(payload ? { "content-type": "application/json" } : {}),
        },
        ...(payload ? { payload } : {}),
      });

    const created = await v1("POST", "/roles", {
      name: "support",
      description: "Answers customers",
      permissions: ["orders:read", "orders:*"],
    });
    expect(created.statusCode).toBe(201);
    expectPublicContract("POST", `/v1/user-pools/${pool}/roles`, created);
    expect(JSON.parse(identity.requests.at(-1)!.body.toString())).toEqual({
      name: "support",
      description: "Answers customers",
      permissions: ["orders:read", "orders:*"],
    });

    const listed = await v1("GET", "/roles");
    expectPublicContract("GET", `/v1/user-pools/${pool}/roles`, listed);
    expect(listed.json()).toMatchObject({ roles: [{ name: "support" }] });

    const changed = await v1("PATCH", "/roles/support", {
      permissions: ["orders:read"],
    });
    expect(changed.json()).toMatchObject({ permissions: ["orders:read"] });

    const given = await v1("PUT", `/users/${identity.user.id}/roles/support`);
    expect(given.statusCode).toBe(200);
    expectPublicContract(
      "PUT",
      `/v1/user-pools/${pool}/users/${identity.user.id}/roles/support`,
      given,
    );
    expect(given.json()).toMatchObject({ roles: ["support"] });
    expect(identity.requests.at(-1)!.headers["x-tenant-id"]).toBe(workspace);

    const taken = await v1(
      "DELETE",
      `/users/${identity.user.id}/roles/support`,
    );
    expect(taken.json()).toMatchObject({ roles: [] });
    expect((await v1("DELETE", "/roles/support")).statusCode).toBe(204);
    expect(identity.problems).toEqual([]);
  });

  it("refuses bad names, permissions and fields before the identity service", async () => {
    const { workspace, pool } = await workspaceWithPool();
    const key = await appKey(workspace);
    const before = identity.requests.length;
    const post = (payload: object) =>
      app.inject({
        method: "POST",
        url: `/v1/user-pools/${pool}/roles`,
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        payload,
      });
    for (const payload of [
      { name: "Admin", permissions: [] },
      { name: "a/b", permissions: [] },
      { name: "ok", permissions: ["drop table"] },
      { name: "ok", permissions: [], userCount: 5 },
    ]) {
      expectError(await post(payload), 400, "BAD_REQUEST");
    }
    expectError(
      await app.inject({
        method: "PUT",
        url: `/v1/user-pools/${pool}/users/${identity.user.id}/roles/..%2Fadmin`,
        headers: { authorization: `Bearer ${key}` },
      }),
      400,
      "BAD_REQUEST",
    );
    expect(identity.requests.length).toBe(before);
  });

  it("in the dashboard, owners change roles; members only view", async () => {
    const { owner, workspace, pool } = await workspaceWithPool();
    const created = await owner.request(
      "POST",
      owner.ws(workspace, `/user-pools/${pool}/roles`),
      {
        body: { name: "editor", permissions: ["posts:write"] },
      },
    );
    expect(created.statusCode).toBe(201);
    const given = await owner.request(
      "PUT",
      owner.ws(
        workspace,
        `/user-pools/${pool}/users/${identity.user.id}/roles/editor`,
      ),
    );
    expect(given.json()).toMatchObject({ roles: ["editor"] });

    const member = new Browser(app);
    await member.signUp("member@example.com", "Member's own");
    const me = await member.request("GET", "/dashboard/v1/auth/me");
    await insertMembership(db, {
      userId: me.json<{ user: { id: string } }>().user.id,
      tenantId: workspace,
      role: "member",
    });
    expect(
      (
        await member.request(
          "GET",
          member.ws(workspace, `/user-pools/${pool}/roles`),
        )
      ).statusCode,
    ).toBe(200);
    for (const [method, path, body] of [
      ["POST", `/user-pools/${pool}/roles`, { name: "x", permissions: [] }],
      ["PATCH", `/user-pools/${pool}/roles/editor`, { permissions: [] }],
      ["DELETE", `/user-pools/${pool}/roles/editor`, undefined],
      [
        "DELETE",
        `/user-pools/${pool}/users/${identity.user.id}/roles/editor`,
        undefined,
      ],
    ] as const) {
      expectError(
        await member.request(
          method,
          member.ws(workspace, path),
          body ? { body } : {},
        ),
        403,
        "FORBIDDEN",
      );
    }
  });
});

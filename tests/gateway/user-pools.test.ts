import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../services/gateway/src/db/client.js";
import { expectPublicContract } from "./contract-helpers.js";
import { fakeIdentity } from "./dashboard-helpers.js";
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

beforeEach(async () => {
  ({ db } = await createTestDatabase());
  identity = await fakeIdentity();
  app = await startGateway({
    db,
    audit: new FakeAudit(),
    identityUrl: identity.url,
  });
});

async function workspaceWithPool() {
  const { tenantId: workspace, key } = await createTenantWithKey(app, "Shop");
  const created = await fetch(`${identity.url}/pools`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tenant-id": workspace,
      "x-request-id": randomUUID(),
    },
    body: JSON.stringify({ name: "Customers" }),
  });
  expect(created.status).toBe(201);
  const { id: pool } = (await created.json()) as { id: string };
  return { workspace, key, pool };
}

describe("/v1/user-pools (apps, with an API key)", () => {
  it("forwards only the validated fields, with the tenant from the key", async () => {
    const { workspace, pool, key: apiKey } = await workspaceWithPool();
    const { key } = await createTenantWithKey(app, "other");

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

describe("user pool roles (docs/decisions/0030)", () => {
  it("an app manages roles and gives them to users, with only valid values forwarded", async () => {
    const { workspace, pool, key } = await workspaceWithPool();
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
    const { pool, key } = await workspaceWithPool();
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
});

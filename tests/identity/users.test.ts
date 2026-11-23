import { describe, expect, it } from "vitest";
import {
  call,
  captureLogs,
  createPool,
  newTenant,
  PASSWORD,
  signUp,
  startIdentity,
  type Tokens,
} from "./helpers.js";

describe("pool users", () => {
  it("signs a user up (email lower-cased), with the app's attributes", async () => {
    const { app, audit } = await startIdentity();
    const tenant = newTenant();
    const pool = await createPool(app, tenant);

    const response = await call(app, tenant, "POST", `/pools/${pool}/users`, {
      email: "Ada@Example.COM",
      password: PASSWORD,
      attributes: { name: "Ada", plan: "pro", beta: true },
    });

    expect(response.statusCode).toBe(201);
    const user = response.json<Record<string, unknown>>();
    expect(user).toMatchObject({
      email: "ada@example.com",
      status: "active",
      locked: false,
      passwordResetRequired: false,
      attributes: { name: "Ada", plan: "pro", beta: true },
      lastLoginAt: null,
    });
    expect(response.body).not.toContain(PASSWORD);
    expect(response.body).not.toContain("argon2");
    expect(audit.events.at(-1)).toMatchObject({
      action: "pool_user.signed_up",
      resourceId: user.id,
      poolId: pool,
    });
    expect(JSON.stringify(audit.events)).not.toContain("ada@example.com");
  });

  it("refuses a taken email (any case), a weak password and bad attributes", async () => {
    const { app } = await startIdentity();
    const tenant = newTenant();
    const pool = await createPool(app, tenant, {
      name: "Strict",
      minPasswordLength: 20,
    });
    await signUp(app, tenant, pool, "taken@example.com");
    const url = `/pools/${pool}/users`;

    const taken = await call(app, tenant, "POST", url, {
      email: "TAKEN@example.com",
      password: `${PASSWORD}-other`,
    });
    const short = await call(app, tenant, "POST", url, {
      email: "short@example.com",
      password: "only-15-letters",
    });
    const common = await call(app, tenant, "POST", url, {
      email: "common@example.com",
      password: "correcthorsebatterystaple",
    });

    expect(taken.statusCode).toBe(409);
    expect(short.statusCode).toBe(400);
    expect(short.json()).toMatchObject({
      error: { message: "The password must be at least 20 characters" },
    });
    expect(common.statusCode).toBe(400);
    for (const attributes of [
      { "bad name": "x" },
      { nested: { no: true } },
      { long: "x".repeat(201) },
    ]) {
      const response = await call(app, tenant, "POST", url, {
        email: "attrs@example.com",
        password: PASSWORD,
        attributes,
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it("lists users newest first, page by page, and finds them by email", async () => {
    const { app, clock } = await startIdentity();
    const tenant = newTenant();
    const pool = await createPool(app, tenant);
    for (const name of ["a", "b", "c"]) {
      await signUp(app, tenant, pool, `${name}@example.com`);
      clock.now += 1000;
    }
    const page = (query: string) =>
      call(app, tenant, "GET", `/pools/${pool}/users${query}`).then((r) =>
        r.json<{ users: { email: string }[]; nextCursor: string | null }>(),
      );

    const first = await page("?limit=2");
    const second = await page(`?limit=2&cursor=${first.nextCursor}`);
    const found = await page("?email=B@EXAMPLE");

    expect(first.users).toHaveLength(2);
    expect(second.users).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.users, ...second.users].map((u) => u.email)).size,
    ).toBe(3);
    expect(found.users.map((u) => u.email)).toEqual(["b@example.com"]);
    expect((await page("?email=%25")).users).toEqual([]);
  });

  it("a disabled user can't sign in and their sessions end; enabling lets them back", async () => {
    const { app } = await startIdentity();
    const tenant = newTenant();
    const pool = await createPool(app, tenant);
    const user = await signUp(app, tenant, pool, "dis@example.com");
    const login = () =>
      call(app, tenant, "POST", `/pools/${pool}/sessions`, {
        email: "dis@example.com",
        password: PASSWORD,
      });
    const tokens = (await login()).json<Tokens>();

    const disabled = await call(
      app,
      tenant,
      "PATCH",
      `/pools/${pool}/users/${user}`,
      {
        status: "disabled",
      },
    );
    expect(disabled.json()).toMatchObject({ status: "disabled" });
    expect((await login()).statusCode).toBe(401);
    const refresh = await call(
      app,
      tenant,
      "POST",
      `/pools/${pool}/sessions/refresh`,
      {
        refreshToken: tokens.refreshToken,
      },
    );
    expect(refresh.statusCode).toBe(401);

    await call(app, tenant, "PATCH", `/pools/${pool}/users/${user}`, {
      status: "active",
    });
    expect((await login()).statusCode).toBe(200);
  });

  it("deletes a user; another tenant can't touch them", async () => {
    const { app } = await startIdentity();
    const tenant = newTenant();
    const pool = await createPool(app, tenant);
    const user = await signUp(app, tenant, pool, "gone@example.com");
    const url = `/pools/${pool}/users/${user}`;

    expect((await call(app, newTenant(), "DELETE", url)).statusCode).toBe(404);
    expect((await call(app, tenant, "DELETE", url)).statusCode).toBe(204);
    expect((await call(app, tenant, "GET", url)).statusCode).toBe(404);
  });

  it("an owner's reset ends the sessions and makes the next sign-in ask for a new password until it is changed", async () => {
    const { app, audit } = await startIdentity();
    const logs = captureLogs();
    const tenant = newTenant();
    const pool = await createPool(app, tenant);
    const user = await signUp(app, tenant, pool, "reset@example.com");
    const login = (password: string) =>
      call(app, tenant, "POST", `/pools/${pool}/sessions`, {
        email: "reset@example.com",
        password,
      });
    const before = (await login(PASSWORD)).json<Tokens>();
    expect(before.passwordResetRequired).toBe(false);

    const reset = await call(
      app,
      tenant,
      "POST",
      `/pools/${pool}/users/${user}/reset-password`,
    );
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({
      id: user,
      passwordResetRequired: true,
    });
    expect(reset.body).not.toContain("temporaryPassword");
    const oldSession = await call(
      app,
      tenant,
      "POST",
      `/pools/${pool}/sessions/refresh`,
      { refreshToken: before.refreshToken },
    );
    expect(oldSession.statusCode).toBe(401);

    const signedIn = await login(PASSWORD);
    expect(signedIn.statusCode).toBe(200);
    expect(signedIn.json<Tokens>().passwordResetRequired).toBe(true);

    const changed = await call(
      app,
      tenant,
      "POST",
      `/pools/${pool}/users/${user}/password`,
      { currentPassword: PASSWORD, newPassword: "a-brand-new-password-42" },
    );
    expect(changed.statusCode).toBe(204);
    const after = await login("a-brand-new-password-42");
    expect(after.json<Tokens>().passwordResetRequired).toBe(false);

    expect(
      audit.events.find((e) => e.action === "pool_user.password_reset"),
    ).toMatchObject({ resourceId: user, poolId: pool });
    expect(logs.text()).not.toContain("a-brand-new-password-42");
  });

  it("an owner unlocks a user locked after wrong passwords", async () => {
    const { app, audit } = await startIdentity();
    const tenant = newTenant();
    const pool = await createPool(app, tenant);
    const user = await signUp(app, tenant, pool, "locked@example.com");
    const login = (password: string) =>
      call(app, tenant, "POST", `/pools/${pool}/sessions`, {
        email: "locked@example.com",
        password,
      });
    for (let i = 0; i < 5; i++) await login("wrong-password-123");
    expect((await login(PASSWORD)).statusCode).toBe(401);
    const lockedUser = await call(
      app,
      tenant,
      "GET",
      `/pools/${pool}/users/${user}`,
    );
    expect(lockedUser.json()).toMatchObject({ status: "active", locked: true });

    const unlocked = await call(
      app,
      tenant,
      "POST",
      `/pools/${pool}/users/${user}/unlock`,
    );
    expect(unlocked.statusCode).toBe(200);
    expect(unlocked.json()).toMatchObject({ locked: false });
    expect((await login(PASSWORD)).statusCode).toBe(200);
    expect(
      audit.events.find((e) => e.action === "pool_user.unlocked"),
    ).toMatchObject({ resourceId: user, poolId: pool, tenantId: tenant });

    const otherTenant = await call(
      app,
      newTenant(),
      "POST",
      `/pools/${pool}/users/${user}/unlock`,
    );
    expect(otherTenant.statusCode).toBe(404);
  });

  it("pool user and role events name their pool; pool changes do not", async () => {
    const { app, audit } = await startIdentity();
    const tenant = newTenant();
    const pool = await createPool(app, tenant);
    await signUp(app, tenant, pool, "events@example.com");
    await call(app, tenant, "POST", `/pools/${pool}/roles`, {
      name: "editor",
      permissions: ["posts:write"],
    });

    const byAction = new Map(audit.events.map((e) => [e.action, e]));
    expect(byAction.get("user_pool.created")?.poolId).toBeUndefined();
    expect(byAction.get("pool_user.signed_up")?.poolId).toBe(pool);
    expect(byAction.get("pool_role.created")?.poolId).toBe(pool);
  });

  it("a user changes their own password with the current one; their sessions end", async () => {
    const { app } = await startIdentity();
    const tenant = newTenant();
    const pool = await createPool(app, tenant);
    const user = await signUp(app, tenant, pool, "change@example.com");
    const tokens = (
      await call(app, tenant, "POST", `/pools/${pool}/sessions`, {
        email: "change@example.com",
        password: PASSWORD,
      })
    ).json<Tokens>();
    const url = `/pools/${pool}/users/${user}/password`;

    const wrong = await call(app, tenant, "POST", url, {
      currentPassword: "not-the-password",
      newPassword: `${PASSWORD}-new`,
    });
    const ok = await call(app, tenant, "POST", url, {
      currentPassword: PASSWORD,
      newPassword: `${PASSWORD}-new`,
    });

    expect([wrong.statusCode, ok.statusCode]).toEqual([401, 204]);
    const refresh = await call(
      app,
      tenant,
      "POST",
      `/pools/${pool}/sessions/refresh`,
      {
        refreshToken: tokens.refreshToken,
      },
    );
    expect(refresh.statusCode).toBe(401);
  });
});

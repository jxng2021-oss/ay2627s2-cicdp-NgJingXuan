import type { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../services/gateway/src/db/client.js";
import { sessions, users } from "../../services/gateway/src/db/schema.js";
import { Browser, COOKIE, PASSWORD } from "./dashboard-helpers.js";
import {
  captureLogs,
  createTenantWithKey,
  createTestDatabase,
  DASHBOARD_ORIGIN,
  expectError,
  FakeAudit,
  startGateway,
} from "./helpers.js";

let db: Database;
let app: FastifyInstance;
let audit: FakeAudit;
let logs: ReturnType<typeof captureLogs>;

async function start(
  overrides: Parameters<typeof startGateway>[0] extends infer O
    ? Partial<O>
    : never = {},
) {
  ({ db } = await createTestDatabase());
  audit = new FakeAudit();
  logs = captureLogs();
  app = await startGateway({
    db,
    audit,
    logger: { level: "info", stream: logs.stream },
    ...overrides,
  });
}

beforeEach(() => start());

const AUTH = "/dashboard/v1/auth";

describe("sign-up and login", () => {
  it("sign-up creates the user, a workspace and an owner membership, and signs in", async () => {
    const browser = new Browser(app);

    const response = await browser.request("POST", `${AUTH}/sign-up`, {
      body: {
        email: "Alice@Example.COM",
        password: PASSWORD,
        workspaceName: "Alice's",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      user: { email: "alice@example.com" },
      workspaces: [{ name: "Alice's", role: "owner" }],
    });
    const me = await browser.request("GET", `${AUTH}/me`);
    expect(me.json()).toMatchObject({ user: { email: "alice@example.com" } });
    expect(audit.events.map((e) => [e.action, e.actorType])).toEqual([
      ["user.signed_up", "user"],
    ]);
  });

  it("refuses short, overlong and common passwords, and a taken email", async () => {
    const browser = new Browser(app);
    const signUp = (email: string, password: string) =>
      browser.request("POST", `${AUTH}/sign-up`, {
        body: { email, password, workspaceName: "W" },
      });

    expectError(
      await signUp("a@example.com", "short-pass"),
      400,
      "BAD_REQUEST",
    );
    expectError(
      await signUp("a@example.com", "x".repeat(129)),
      400,
      "BAD_REQUEST",
    );
    expectError(
      await signUp("a@example.com", "password1234"),
      400,
      "BAD_REQUEST",
    );
    expect((await signUp("a@example.com", PASSWORD)).statusCode).toBe(201);
    expectError(await signUp("A@EXAMPLE.com", PASSWORD), 409, "CONFLICT");
  });

  it("gives exactly the same answer for a wrong password and an unknown email", async () => {
    await new Browser(app).signUp("bob@example.com");
    const browser = new Browser(app);

    const wrong = await browser.login(
      "bob@example.com",
      "not-the-right-password",
    );
    const unknown = await browser.login(
      "nobody@example.com",
      "not-the-right-password",
    );

    for (const response of [wrong, unknown]) {
      expectError(response, 401, "UNAUTHORIZED");
      expect(response.headers["set-cookie"]).toBeUndefined();
    }
    const message = (r: typeof wrong) =>
      r.json<{ error: { message: string } }>().error.message;
    expect(message(wrong)).toBe(message(unknown));
    const failed = audit.events.filter((e) => e.action === "user.login_failed");
    expect(failed.map((e) => e.tenantId !== undefined)).toEqual([true, false]);
    expect(JSON.stringify(audit.events)).not.toContain("nobody@example.com");
  });

  it("the unknown-email path takes about as long as a wrong password (dummy hash)", async () => {
    await new Browser(app).signUp("carol@example.com");
    const time = async (email: string) => {
      const started = performance.now();
      await new Browser(app).login(email, "not-the-right-password");
      return performance.now() - started;
    };
    await time("warm-up@example.com");

    const known = await time("carol@example.com");
    const unknown = await time("nobody@example.com");

    expect(unknown).toBeGreaterThan(known / 3);
  });

  it("a new session for every login; logout and logout-all end sessions", async () => {
    const first = new Browser(app);
    await first.signUp("dave@example.com");
    const second = new Browser(app);
    await second.login("dave@example.com");
    expect(second.cookie).not.toBe(first.cookie);

    const kept = second.cookieHeader()!;
    const logout = await second.request("POST", `${AUTH}/logout`);
    expect(logout.statusCode).toBe(204);
    expect(second.lastSetCookies).toHaveLength(2);
    expect(second.lastSetCookies.every((c) => c.includes("Max-Age=0"))).toBe(
      true,
    );
    expect(second.cookieHeader()).toBeUndefined();
    expectError(await second.request("GET", `${AUTH}/me`), 401, "UNAUTHORIZED");
    expectError(
      await app.inject({
        method: "GET",
        url: `${AUTH}/me`,
        headers: { origin: DASHBOARD_ORIGIN, cookie: kept },
      }),
      401,
      "UNAUTHORIZED",
    );

    const third = new Browser(app);
    await third.login("dave@example.com");
    expect((await third.request("POST", `${AUTH}/logout-all`)).statusCode).toBe(
      204,
    );
    expectError(await first.request("GET", `${AUTH}/me`), 401, "UNAUTHORIZED");
    expect(
      audit.events.filter((e) => e.action === "user.logged_out"),
    ).toHaveLength(2);
  });

  it("changing the password ends the other sessions, keeps this one, and needs the current password", async () => {
    const browser = new Browser(app);
    await browser.signUp("erin@example.com");
    const other = new Browser(app);
    await other.login("erin@example.com");

    const wrong = await browser.request("POST", `${AUTH}/change-password`, {
      body: {
        currentPassword: "not-my-password",
        newPassword: "a-brand-new-passphrase",
      },
    });
    const changed = await browser.request("POST", `${AUTH}/change-password`, {
      body: {
        currentPassword: PASSWORD,
        newPassword: "a-brand-new-passphrase",
      },
    });

    expectError(wrong, 401, "UNAUTHORIZED");
    expect(changed.statusCode).toBe(204);
    expect((await browser.request("GET", `${AUTH}/me`)).statusCode).toBe(200);
    expectError(await other.request("GET", `${AUTH}/me`), 401, "UNAUTHORIZED");
    expect((await new Browser(app).login("erin@example.com")).statusCode).toBe(
      401,
    );
    expect(
      (
        await new Browser(app).login(
          "erin@example.com",
          "a-brand-new-passphrase",
        )
      ).statusCode,
    ).toBe(200);
    expect(audit.events.map((e) => e.action)).toContain(
      "user.password_changed",
    );
  });

  it("refuses a sign-up and a password change if they can't be recorded (503)", async () => {
    const browser = new Browser(app);
    await browser.signUp("frank@example.com");
    audit.down = true;

    const signUp = await new Browser(app).request("POST", `${AUTH}/sign-up`, {
      body: {
        email: "gina@example.com",
        password: PASSWORD,
        workspaceName: "G",
      },
    });
    const change = await browser.request("POST", `${AUTH}/change-password`, {
      body: {
        currentPassword: PASSWORD,
        newPassword: "a-brand-new-passphrase",
      },
    });

    expectError(signUp, 503, "SERVICE_UNAVAILABLE");
    expectError(change, 503, "SERVICE_UNAVAILABLE");
    audit.down = false;
    expect((await new Browser(app).login("gina@example.com")).statusCode).toBe(
      401,
    );
    expect((await new Browser(app).login("frank@example.com")).statusCode).toBe(
      200,
    );
  });
});

describe("sessions expire", () => {
  it("after the idle timeout (the refresh token can't revive it)", async () => {
    await start({
      dashboard: {
        ...dashboardSettings(),
        session: { ...dashboardSettings().session, idleTimeoutMs: 200 },
      },
    });
    const browser = new Browser(app);
    await browser.signUp("idle@example.com");
    expect((await browser.request("GET", `${AUTH}/me`)).statusCode).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 300));

    expectError(
      await browser.request("GET", `${AUTH}/me`),
      401,
      "UNAUTHORIZED",
    );
  });

  it("after the absolute timeout, even while in use", async () => {
    await start({
      dashboard: {
        ...dashboardSettings(),
        session: { ...dashboardSettings().session, absoluteTimeoutMs: 300 },
      },
    });
    const browser = new Browser(app);
    await browser.signUp("absolute@example.com");

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await browser.request("GET", `${AUTH}/me`)).statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expectError(
      await browser.request("GET", `${AUTH}/me`),
      401,
      "UNAUTHORIZED",
    );
  });
});

describe("silent refresh (on the server, no refresh route)", () => {
  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  const withSession = (session: Record<string, number>) =>
    start({
      dashboard: {
        ...dashboardSettings(),
        session: { ...dashboardSettings().session, ...session },
      },
    });

  it("an expired access token is renewed by the refresh token, inside the same request", async () => {
    await withSession({ accessTtlMs: 100 });
    const browser = new Browser(app);
    await browser.signUp("refresh@example.com");
    const before = { access: browser.cookie, refresh: browser.refresh };
    const csrf = browser.csrf;

    await sleep(150);
    const me = await browser.request("GET", `${AUTH}/me`);

    expect(me.statusCode).toBe(200);
    expect(browser.lastSetCookies).toHaveLength(2);
    expect(browser.cookie).not.toBe(before.access);
    expect(browser.refresh).not.toBe(before.refresh);
    expect(browser.csrf).toBe(csrf);
    expect((await browser.request("POST", `${AUTH}/logout`)).statusCode).toBe(
      204,
    );
  });

  it("a missing access cookie is renewed too; a valid one is used as it is", async () => {
    const browser = new Browser(app);
    await browser.signUp("missing@example.com");
    const plain = await browser.request("GET", `${AUTH}/me`);
    expect(plain.headers["set-cookie"]).toBeUndefined();

    browser.cookie = undefined;
    const me = await browser.request("GET", `${AUTH}/me`);
    expect(me.statusCode).toBe(200);
    expect(browser.cookie).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("requests sent together with the same refresh token all succeed, but only one renews", async () => {
    await withSession({ accessTtlMs: 50 });
    const browser = new Browser(app);
    await browser.signUp("parallel@example.com");
    await sleep(100);
    const stale = browser.cookieHeader()!;

    const first = await browser.request("GET", `${AUTH}/me`);
    const second = await app.inject({
      method: "GET",
      url: `${AUTH}/me`,
      headers: { origin: DASHBOARD_ORIGIN, cookie: stale },
    });

    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect(first.headers["set-cookie"]).toBeDefined();
    expect(second.headers["set-cookie"]).toBeUndefined();
    expect((await browser.request("GET", `${AUTH}/me`)).statusCode).toBe(200);
  });

  it("a replaced refresh token used again later revokes the whole session", async () => {
    await withSession({ accessTtlMs: 50, refreshGraceMs: 50 });
    const browser = new Browser(app);
    await browser.signUp("stolen@example.com");
    await sleep(100);
    const copy = browser.cookieHeader()!;
    expect((await browser.request("GET", `${AUTH}/me`)).statusCode).toBe(200);
    await sleep(100);

    const replay = await app.inject({
      method: "GET",
      url: `${AUTH}/me`,
      headers: { origin: DASHBOARD_ORIGIN, cookie: copy },
    });
    expectError(replay, 401, "UNAUTHORIZED");
    expect([replay.headers["set-cookie"]].flat().join()).toContain("Max-Age=0");
    expectError(
      await browser.request("GET", `${AUTH}/me`),
      401,
      "UNAUTHORIZED",
    );
  });

  it("only takes each token in its own cookie", async () => {
    const browser = new Browser(app);
    await browser.signUp("swapped@example.com");
    const asAccess = await app.inject({
      method: "GET",
      url: `${AUTH}/me`,
      headers: {
        origin: DASHBOARD_ORIGIN,
        cookie: `${COOKIE}=${browser.refresh}`,
      },
    });
    expectError(asAccess, 401, "UNAUTHORIZED");
  });
});

describe("cookies", () => {
  it("are HttpOnly, Secure and limited to /dashboard: a short access cookie, and a SameSite=Strict refresh cookie until the absolute timeout", async () => {
    const browser = new Browser(app);
    await browser.signUp("cookie@example.com");

    expect(browser.lastSetCookies).toHaveLength(2);
    expect(browser.lastSetCookies[0]).toMatch(
      /^__Secure-scp_session=[A-Za-z0-9_-]{43}; Path=\/dashboard; Max-Age=900; HttpOnly; SameSite=Lax; Secure$/,
    );
    expect(browser.lastSetCookies[1]).toMatch(
      /^__Secure-scp_refresh=[A-Za-z0-9_-]{43}; Path=\/dashboard; Max-Age=(43199|43200); HttpOnly; SameSite=Strict; Secure$/,
    );
    expect(browser.refresh).not.toBe(browser.cookie);
  });

  it("aren't Secure only when SESSION_COOKIE_SECURE is off (local http)", async () => {
    const settings = dashboardSettings();
    await start({
      dashboard: {
        ...settings,
        session: { ...settings.session, cookieSecure: false },
      },
    });
    const response = await app.inject({
      method: "POST",
      url: `${AUTH}/sign-up`,
      headers: { origin: DASHBOARD_ORIGIN, "content-type": "application/json" },
      payload: {
        email: "local@example.com",
        password: PASSWORD,
        workspaceName: "L",
      },
    });

    const [access, refresh] = [response.headers["set-cookie"]].flat();
    expect(access).toMatch(/^scp_session=.*HttpOnly; SameSite=Lax$/);
    expect(refresh).toMatch(/^scp_refresh=.*HttpOnly; SameSite=Strict$/);
  });
});

describe("CSRF, Origin and CORS", () => {
  it("refuses changes without the dashboard's Origin, before anything else", async () => {
    const browser = new Browser(app);
    await browser.signUp("csrf@example.com");

    for (const origin of [
      null,
      "https://evil.example",
      "https://dashboard.test.evil.example",
    ]) {
      expectError(
        await browser.request("POST", `${AUTH}/logout`, { origin }),
        403,
        "FORBIDDEN",
      );
      expectError(
        await new Browser(app).request("POST", `${AUTH}/login`, {
          origin,
          body: { email: "csrf@example.com", password: PASSWORD },
        }),
        403,
        "FORBIDDEN",
      );
    }
    expect((await browser.request("GET", `${AUTH}/me`)).statusCode).toBe(200);
  });

  it("refuses changes with a missing or wrong CSRF token, or another session's", async () => {
    const browser = new Browser(app);
    await browser.signUp("token@example.com");
    const other = new Browser(app);
    await other.signUp("other@example.com");

    expectError(
      await browser.request("POST", `${AUTH}/logout`, { csrf: false }),
      403,
      "FORBIDDEN",
    );
    expectError(
      await browser.request("POST", `${AUTH}/logout`, {
        csrf: false,
        headers: { "x-csrf-token": "x".repeat(43) },
      }),
      403,
      "FORBIDDEN",
    );
    expectError(
      await browser.request("POST", `${AUTH}/logout`, {
        csrf: false,
        headers: { "x-csrf-token": other.csrf! },
      }),
      403,
      "FORBIDDEN",
    );
    expect((await browser.request("GET", `${AUTH}/me`)).statusCode).toBe(200);
    expect((await browser.request("POST", `${AUTH}/logout`)).statusCode).toBe(
      204,
    );
  });

  it("sends CORS headers with credentials only to the dashboard's origin, and answers its preflight", async () => {
    const allowed = await app.inject({
      method: "GET",
      url: `${AUTH}/me`,
      headers: { origin: DASHBOARD_ORIGIN },
    });
    const other = await app.inject({
      method: "GET",
      url: `${AUTH}/me`,
      headers: { origin: "https://evil.example" },
    });
    const preflight = await app.inject({
      method: "OPTIONS",
      url: `${AUTH}/login`,
      headers: {
        origin: DASHBOARD_ORIGIN,
        "access-control-request-method": "POST",
      },
    });
    const badPreflight = await app.inject({
      method: "OPTIONS",
      url: `${AUTH}/login`,
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "POST",
      },
    });

    expect(allowed.headers).toMatchObject({
      "access-control-allow-origin": DASHBOARD_ORIGIN,
      "access-control-allow-credentials": "true",
      "access-control-expose-headers": "x-request-id, retry-after",
    });
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-headers"]).toContain(
      "x-csrf-token",
    );
    const methods = String(
      preflight.headers["access-control-allow-methods"],
    ).split(", ");
    expect(methods).toEqual(
      expect.arrayContaining(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    );
    expect(badPreflight.statusCode).toBe(403);
  });

  it("adds security headers to every dashboard answer", async () => {
    const response = await app.inject({ method: "GET", url: `${AUTH}/me` });

    expect(response.headers).toMatchObject({
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "strict-transport-security": "max-age=31536000",
    });
  });
});

describe("sessions and API keys stay apart", () => {
  it("API keys don't work on dashboard routes, and sessions don't work on /v1 routes", async () => {
    const { key } = await createTenantWithKey(app);
    const browser = new Browser(app);
    await browser.signUp("apart@example.com");

    const keyOnDashboard = await app.inject({
      method: "GET",
      url: `${AUTH}/me`,
      headers: { authorization: `Bearer ${key}` },
    });
    const sessionOnV1 = await browser.request("GET", "/v1/secrets");

    expectError(keyOnDashboard, 401, "UNAUTHORIZED");
    expectError(sessionOnV1, 401, "UNAUTHORIZED");
  });
});

describe("rate limits", () => {
  it("limits auth attempts per email, and per IP, before checking anything", async () => {
    await start({
      dashboard: {
        ...dashboardSettings(),
        authLimits: { perIp: 5, perEmail: 3 },
      },
    });
    await new Browser(app).signUp("limited@example.com");

    const attempts = [];
    for (let i = 0; i < 4; i++) {
      attempts.push(
        (
          await new Browser(app).login(
            "limited@example.com",
            "wrong-password-x",
          )
        ).statusCode,
      );
    }
    expect(attempts).toEqual([401, 401, 429, 429]);
    const otherEmail = await new Browser(app).login(
      "someone-else@example.com",
      "wrong-password-x",
    );
    expect(otherEmail.statusCode).toBe(429);
    expect(otherEmail.headers["retry-after"]).toBeDefined();
  });
});

describe("what is stored and logged", () => {
  it("never stores or logs passwords, session tokens or CSRF tokens", async () => {
    const browser = new Browser(app);
    await browser.signUp("secret-keeper@example.com");
    await browser.login("secret-keeper@example.com", "a-wrong-password-123");

    const [user] = await db.select().from(users);
    const stored =
      JSON.stringify(await db.select().from(sessions)) + JSON.stringify(user);
    expect(user!.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    for (const secret of [
      PASSWORD,
      "a-wrong-password-123",
      browser.cookie!,
      browser.refresh!,
      browser.csrf!,
    ]) {
      expect(stored).not.toContain(secret);
      expect(logs.text()).not.toContain(secret);
      expect(JSON.stringify(audit.events)).not.toContain(secret);
    }
    expect(logs.text()).not.toContain(user!.passwordHash);
  });
});

describe("the admin API", () => {
  it("is off unless ADMIN_API_ENABLED is set", async () => {
    await start({ adminApiEnabled: false });

    const response = await app.inject({
      method: "POST",
      url: "/admin/tenants",
      headers: {
        authorization: "Bearer test-admin-token-0123456789abcdef0123456789",
      },
      payload: { name: "x" },
    });

    expectError(response, 404, "NOT_FOUND");
  });
});

function dashboardSettings() {
  return {
    origin: DASHBOARD_ORIGIN,
    session: {
      secret: "test-session-secret-0123456789abcdef0123",
      accessTtlMs: 15 * 60_000,
      idleTimeoutMs: 30 * 60_000,
      absoluteTimeoutMs: 12 * 60 * 60_000,
      refreshGraceMs: 30_000,
      cookieSecure: true,
    },
    authLimits: { perIp: 1_000, perEmail: 1_000 },
  };
}

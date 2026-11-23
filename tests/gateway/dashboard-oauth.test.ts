import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../services/gateway/src/db/client.js";
import { users } from "../../services/gateway/src/db/schema.js";
import { Browser } from "./dashboard-helpers.js";
import {
  captureLogs,
  createTestDatabase,
  DASHBOARD_ORIGIN,
  expectError,
  FakeAudit,
  startGateway,
  TEST_OAUTH,
} from "./helpers.js";

let db: Database;
let app: FastifyInstance;
let audit: FakeAudit;
let logs: ReturnType<typeof captureLogs>;
let provider: FakeProvider;

const AUTH = "/dashboard/v1/auth";
const OAUTH = `${AUTH}/oauth`;

interface Call {
  url: string;
  body: URLSearchParams | undefined;
  authorization: string | undefined;
}

class FakeProvider {
  calls: Call[] = [];
  tokenStatus = 200;
  google = {
    sub: "google-user-1",
    email: "Gina@Example.com",
    email_verified: true as unknown,
    name: "Gina\u0007 Google",
  };
  githubUser = { id: 4242, name: null as string | null, login: "octo-gina" };
  githubEmails: { email: string; primary: boolean; verified: boolean }[] = [
    { email: "old@example.com", primary: false, verified: true },
    { email: "gina@example.com", primary: true, verified: true },
  ];

  fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const headers = new Headers(init?.headers);
    this.calls.push({
      url,
      body:
        init?.body instanceof URLSearchParams
          ? new URLSearchParams(init.body)
          : undefined,
      authorization: headers.get("authorization") ?? undefined,
    });
    const json = (body: unknown, status = 200) =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    if (url.endsWith("/token") || url.endsWith("/access_token")) {
      return json({ access_token: "provider-access-token" }, this.tokenStatus);
    }
    if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
      return json(this.google);
    }
    if (url === "https://api.github.com/user") return json(this.githubUser);
    if (url === "https://api.github.com/user/emails") {
      return json(this.githubEmails);
    }
    return json({}, 404);
  };
}

async function start(oauth = TEST_OAUTH) {
  ({ db } = await createTestDatabase());
  audit = new FakeAudit();
  logs = captureLogs();
  provider = new FakeProvider();
  app = await startGateway({
    db,
    audit,
    oauthFetch: provider.fetch,
    logger: { level: "info", stream: logs.stream },
    dashboard: {
      origin: DASHBOARD_ORIGIN,
      session: {
        secret: "test-session-secret-0123456789abcdef0123",
        accessTtlMs: 15 * 60_000,
        refreshTtlMs: 30 * 24 * 60 * 60_000,
        refreshGraceMs: 30_000,
        cookieSecure: true,
      },
      authLimits: { perIp: 1_000, perEmail: 1_000 },
      oauth,
    },
  });
}

beforeEach(() => start());

const location = (response: LightMyRequestResponse) =>
  new URL(String(response.headers.location));

async function begin(browser: Browser, name: "google" | "github") {
  const response = await browser.request("GET", `${OAUTH}/${name}/start`, {
    origin: null,
  });
  const stateCookie = [response.headers["set-cookie"]]
    .flat()
    .find((line) => line?.startsWith("__Secure-scp_oauth="))!;
  return {
    response,
    stateCookie,
    cookie: stateCookie.split(";")[0]!,
    state: location(response).searchParams.get("state")!,
    challenge: location(response).searchParams.get("code_challenge")!,
  };
}

async function finish(
  browser: Browser,
  name: "google" | "github",
  query: string,
  cookie?: string,
) {
  return browser.request("GET", `${OAUTH}/${name}/callback?${query}`, {
    origin: null,
    headers: cookie ? { cookie } : {},
  });
}

async function signInWith(browser: Browser, name: "google" | "github") {
  const started = await begin(browser, name);
  return finish(
    browser,
    name,
    `code=the-code&state=${started.state}&scope=email`,
    started.cookie,
  );
}

const oauthError = (response: LightMyRequestResponse) => {
  expect(response.statusCode).toBe(302);
  const url = location(response);
  expect(`${url.origin}${url.pathname}`).toBe(`${DASHBOARD_ORIGIN}/login`);
  return url.searchParams.get("oauth_error");
};

describe("Continue with Google or GitHub", () => {
  it("lists only the providers that are set up", async () => {
    const browser = new Browser(app);
    expect((await browser.request("GET", `${OAUTH}/providers`)).json()).toEqual(
      { providers: ["google", "github"] },
    );

    await start({ ...TEST_OAUTH, github: undefined });
    expect(
      (await new Browser(app).request("GET", `${OAUTH}/providers`)).json(),
    ).toEqual({ providers: ["google"] });
    expect(
      oauthError(
        await new Browser(app).request("GET", `${OAUTH}/github/start`, {
          origin: null,
        }),
      ),
    ).toBe("unavailable");
  });

  it("start redirects to the provider with a state and an S256 PKCE challenge, kept in a short signed cookie", async () => {
    const started = await begin(new Browser(app), "google");

    expect(started.response.statusCode).toBe(302);
    const url = location(started.response);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "google-client-id",
      redirect_uri: "https://api.test/dashboard/v1/auth/oauth/google/callback",
      response_type: "code",
      scope: "openid email profile",
      code_challenge_method: "S256",
    });
    expect(started.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(started.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.has("client_secret")).toBe(false);
    expect(started.stateCookie).toMatch(
      /^__Secure-scp_oauth=google\.[A-Za-z0-9_-]{43}\.[0-9]{10}\.[A-Za-z0-9_-]{43}; Path=\/dashboard\/v1\/auth\/oauth; Max-Age=600; HttpOnly; SameSite=Lax; Secure$/,
    );
  });

  it("a new Google user gets an account with no password and no workspace, and a session", async () => {
    const browser = new Browser(app);
    const started = await begin(browser, "google");
    const response = await finish(
      browser,
      "google",
      `code=the-code&state=${started.state}&authuser=0`,
      started.cookie,
    );

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`${DASHBOARD_ORIGIN}/workspaces`);
    const cookies = [response.headers["set-cookie"]].flat();
    expect(cookies[0]).toMatch(/^__Secure-scp_oauth=; .*Max-Age=0/);
    expect(browser.cookie).toBeDefined();
    expect(browser.refresh).toBeDefined();

    const exchange = provider.calls[0]!;
    expect(exchange.url).toBe("https://oauth2.googleapis.com/token");
    expect(exchange.body?.get("client_secret")).toBe("google-secret");
    expect(exchange.body?.get("code")).toBe("the-code");
    const verifier = exchange.body!.get("code_verifier")!;
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
      started.challenge,
    );
    expect(provider.calls[1]!.authorization).toBe(
      "Bearer provider-access-token",
    );

    const me = (await browser.request("GET", `${AUTH}/me`)).json<{
      user: { email: string; displayName: string; hasPassword: boolean };
      workspaces: unknown[];
    }>();
    expect(me.user).toMatchObject({
      email: "gina@example.com",
      displayName: "Gina Google",
      hasPassword: false,
    });
    expect(me.workspaces).toEqual([]);
    expectError(
      await new Browser(app).login("gina@example.com", "anything-at-all-1"),
      401,
      "UNAUTHORIZED",
    );
    for (const secret of ["provider-access-token", "google-secret", verifier]) {
      expect(logs.text()).not.toContain(secret);
    }
  });

  it("the same Google account signs in to the same user, even after its email changes", async () => {
    await signInWith(new Browser(app), "google");
    provider.google.email = "gina.new@example.com";

    const browser = new Browser(app);
    await signInWith(browser, "google");

    const me = (await browser.request("GET", `${AUTH}/me`)).json<{
      user: { email: string };
    }>();
    expect(me.user.email).toBe("gina@example.com");
    expect(await db.select().from(users)).toHaveLength(1);
  });

  it("GitHub uses the primary verified email", async () => {
    const browser = new Browser(app);
    const response = await signInWith(browser, "github");

    expect(response.headers.location).toBe(`${DASHBOARD_ORIGIN}/workspaces`);
    expect(provider.calls.map((call) => call.url)).toEqual([
      "https://github.com/login/oauth/access_token",
      "https://api.github.com/user",
      "https://api.github.com/user/emails",
    ]);
    const me = (await browser.request("GET", `${AUTH}/me`)).json<{
      user: { email: string; displayName: string };
    }>();
    expect(me.user).toMatchObject({
      email: "gina@example.com",
      displayName: "octo-gina",
    });
  });

  it("refuses emails the provider hasn't verified", async () => {
    provider.google.email_verified = "true";
    expect(oauthError(await signInWith(new Browser(app), "google"))).toBe(
      "email_unverified",
    );
    provider.githubEmails = [
      { email: "gina@example.com", primary: true, verified: false },
    ];
    expect(oauthError(await signInWith(new Browser(app), "github"))).toBe(
      "email_unverified",
    );
    expect(await db.select().from(users)).toEqual([]);
  });

  it("links to an existing account with the same email: both ways of signing in keep working", async () => {
    const owner = new Browser(app);
    await owner.signUp("gina@example.com");
    audit.events.length = 0;

    const browser = new Browser(app);
    await signInWith(browser, "google");

    const me = (await browser.request("GET", `${AUTH}/me`)).json<{
      user: { hasPassword: boolean };
      workspaces: unknown[];
    }>();
    expect(me.user.hasPassword).toBe(true);
    expect(me.workspaces).toHaveLength(1);
    expect(audit.events.map((e) => e.action)).toEqual([
      "user.oauth_linked",
      "user.logged_in",
    ]);
    expect(audit.events[0]!.tenantId).toBeUndefined();
    expect((await new Browser(app).login("gina@example.com")).statusCode).toBe(
      200,
    );
  });

  it("refuses a missing, wrong, expired or other provider's state, and a cancelled sign in", async () => {
    const browser = new Browser(app);
    const started = await begin(browser, "google");

    expect(
      oauthError(
        await finish(browser, "google", `code=c&state=${started.state}`),
      ),
    ).toBe("failed");
    expect(
      oauthError(
        await finish(
          browser,
          "google",
          `code=c&state=${"x".repeat(43)}`,
          started.cookie,
        ),
      ),
    ).toBe("failed");
    expect(
      oauthError(
        await finish(
          browser,
          "github",
          `code=c&state=${started.state}`,
          started.cookie.replace("scp_oauth=google", "scp_oauth=github"),
        ),
      ),
    ).toBe("failed");
    const tampered = started.cookie.replace(/\.[0-9]{10}\./, ".9999999999.");
    expect(
      oauthError(
        await finish(
          browser,
          "google",
          `code=c&state=${started.state}`,
          tampered,
        ),
      ),
    ).toBe("failed");
    expect(
      oauthError(
        await finish(
          browser,
          "google",
          `error=access_denied&state=${started.state}`,
          started.cookie,
        ),
      ),
    ).toBe("cancelled");
    expect(provider.calls).toEqual([]);
  });

  it("a provider failure sends the browser back with a generic error", async () => {
    provider.tokenStatus = 500;
    expect(oauthError(await signInWith(new Browser(app), "google"))).toBe(
      "failed",
    );
  });

  it("a disabled account can't sign in", async () => {
    await signInWith(new Browser(app), "google");
    await db.update(users).set({ status: "disabled" });

    expect(oauthError(await signInWith(new Browser(app), "google"))).toBe(
      "disabled",
    );
  });

  it("an account without a password can't change one, and deletes itself by typing its email", async () => {
    const browser = new Browser(app);
    await signInWith(browser, "google");
    await browser.refreshCsrf();

    expectError(
      await browser.request("POST", `${AUTH}/change-password`, {
        body: { currentPassword: "x", newPassword: "a-long-new-password-1" },
      }),
      400,
      "BAD_REQUEST",
    );
    expectError(
      await browser.request("POST", "/dashboard/v1/account/delete", {
        body: { email: "someone@example.com" },
      }),
      400,
      "BAD_REQUEST",
    );
    const deleted = await browser.request(
      "POST",
      "/dashboard/v1/account/delete",
      { body: { email: "Gina@example.com" } },
    );
    expect(deleted.statusCode).toBe(204);
    expect(
      await db.select().from(users).where(eq(users.email, "gina@example.com")),
    ).toEqual([]);
  });
});

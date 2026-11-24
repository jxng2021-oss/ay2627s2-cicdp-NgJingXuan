import { createPublicKey, randomBytes, verify } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { freshWindow, GATEWAY_URL, psql } from "./helpers.js";

const ORIGIN = process.env.DASHBOARD_ORIGIN ?? "http://localhost:3000";
const PASSWORD = `e2e-pools-${randomBytes(8).toString("hex")}`;
const END_USER_PASSWORD = `end-user-${randomBytes(8).toString("hex")}`;
const NEW_PASSWORD = `new-end-user-${randomBytes(8).toString("hex")}`;

class Browser {
  private readonly jar = new Map<string, string>();
  csrf = "";

  async call(method: string, path: string, body?: unknown) {
    const response = await fetch(`${GATEWAY_URL}/dashboard/v1${path}`, {
      method,
      headers: {
        origin: ORIGIN,
        ...(this.jar.size ? { cookie: this.cookie } : {}),
        ...(this.csrf && method !== "GET" ? { "x-csrf-token": this.csrf } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(";")[0] ?? "";
      const name = pair.slice(0, pair.indexOf("="));
      const value = pair.slice(pair.indexOf("=") + 1);
      if (value) this.jar.set(name, value);
      else this.jar.delete(name);
    }
    return response;
  }

  get cookie(): string {
    return [...this.jar].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  passwordResetRequired: boolean;
  user: { id: string; email: string };
}

let pool = "";
let issuer = "";
let apiKey = "";
let workspace = "";
const owner = new Browser();

function app(method: string, path: string, body?: unknown) {
  return fetch(`${GATEWAY_URL}/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function verifyJwt(token: string, keys: Record<string, string>[]) {
  const [header, payload, signature] = token.split(".");
  const { kid } = JSON.parse(Buffer.from(header!, "base64url").toString()) as {
    kid: string;
  };
  const jwk = keys.find((key) => key.kid === kid);
  if (!jwk) return undefined;
  const ok = verify(
    "sha256",
    Buffer.from(`${header}.${payload}`),
    {
      key: createPublicKey({ key: jwk, format: "jwk" }),
      dsaEncoding: "ieee-p1363",
    },
    Buffer.from(signature!, "base64url"),
  );
  return ok
    ? (JSON.parse(Buffer.from(payload!, "base64url").toString()) as Record<
        string,
        unknown
      >)
    : undefined;
}

beforeAll(async () => {
  await freshWindow();
  const signUp = await owner.call("POST", "/auth/sign-up", {
    email: `e2e-pools-${randomBytes(4).toString("hex")}@example.test`,
    password: PASSWORD,
    workspaceName: "Pools workspace",
  });
  expect(signUp.status).toBe(201);
  workspace = ((await signUp.json()) as { workspaces: { id: string }[] })
    .workspaces[0]!.id;
  owner.csrf = (
    (await (await owner.call("GET", "/auth/csrf")).json()) as {
      csrfToken: string;
    }
  ).csrfToken;

  const created = await owner.call(
    "POST",
    `/workspaces/${workspace}/user-pools`,
    {
      name: "Shop customers",
    },
  );
  expect(created.status).toBe(201);
  ({ id: pool, issuer } = (await created.json()) as {
    id: string;
    issuer: string;
  });

  const key = await owner.call("POST", `/workspaces/${workspace}/api-keys`, {
    name: "shop-server",
  });
  apiKey = ((await key.json()) as { key: string }).key;
});

describe("user pools", () => {
  let tokens: Tokens;

  it("an app signs a user up and in; the token verifies with the public keys (no API key needed)", async () => {
    const signUp = await app("POST", `/user-pools/${pool}/users`, {
      email: "Shopper@Example.test",
      password: END_USER_PASSWORD,
      attributes: { name: "Shopper" },
    });
    expect(signUp.status).toBe(201);

    const signIn = await app("POST", `/user-pools/${pool}/sessions`, {
      email: "shopper@example.test",
      password: END_USER_PASSWORD,
    });
    expect(signIn.status).toBe(200);
    expect(signIn.headers.get("cache-control")).toBe("no-store");
    tokens = (await signIn.json()) as Tokens;

    const jwks = await fetch(`${GATEWAY_URL}/v1/user-pools/${pool}/jwks.json`);
    expect(jwks.status).toBe(200);
    const { keys } = (await jwks.json()) as { keys: Record<string, string>[] };
    const claims = verifyJwt(tokens.accessToken, keys);
    expect(claims).toMatchObject({
      iss: issuer,
      aud: pool,
      sub: tokens.user.id,
      email: "shopper@example.test",
      attributes: { name: "Shopper" },
    });
    expect(Number(claims!.exp)).toBeGreaterThan(Date.now() / 1000);
  });

  it("the same 401 for a wrong password and an unknown email", async () => {
    const wrong = await app("POST", `/user-pools/${pool}/sessions`, {
      email: "shopper@example.test",
      password: "not-the-password-1",
    });
    const unknown = await app("POST", `/user-pools/${pool}/sessions`, {
      email: "nobody@example.test",
      password: "not-the-password-1",
    });
    expect([wrong.status, unknown.status]).toEqual([401, 401]);
    const message = async (r: Response) =>
      ((await r.json()) as { error: { message: string } }).error.message;
    expect(await message(wrong)).toBe(await message(unknown));
  });

  it("a refresh token works once; using it again ends the session", async () => {
    const refresh = (refreshToken: string) =>
      app("POST", `/user-pools/${pool}/sessions/refresh`, { refreshToken });

    const first = await refresh(tokens.refreshToken);
    expect(first.status).toBe(200);
    const renewed = (await first.json()) as Tokens;

    expect((await refresh(tokens.refreshToken)).status).toBe(401);
    expect((await refresh(renewed.refreshToken)).status).toBe(401);
  });

  it("an owner's reset makes the next sign-in ask for a new password, until it is changed", async () => {
    const signIn = (password: string) =>
      app("POST", `/user-pools/${pool}/sessions`, {
        email: tokens.user.email,
        password,
      });
    const userPath = `/workspaces/${workspace}/user-pools/${pool}/users/${tokens.user.id}`;

    const reset = await owner.call("POST", `${userPath}/reset-password`);
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({ passwordResetRequired: true });

    const flagged = await signIn(END_USER_PASSWORD);
    expect(flagged.status).toBe(200);
    expect(((await flagged.json()) as Tokens).passwordResetRequired).toBe(true);

    const changed = await app(
      "POST",
      `/user-pools/${pool}/users/${tokens.user.id}/password`,
      { currentPassword: END_USER_PASSWORD, newPassword: NEW_PASSWORD },
    );
    expect(changed.status).toBe(204);
    const after = await signIn(NEW_PASSWORD);
    expect(((await after.json()) as Tokens).passwordResetRequired).toBe(false);
  });

  it("an owner unlocks a user locked after 5 wrong passwords", async () => {
    const signIn = (password: string) =>
      app("POST", `/user-pools/${pool}/sessions`, {
        email: tokens.user.email,
        password,
      });
    for (let i = 0; i < 5; i++) await signIn("not-the-password-1");
    expect((await signIn(NEW_PASSWORD)).status).toBe(401);
    const userPath = `/workspaces/${workspace}/user-pools/${pool}/users/${tokens.user.id}`;
    expect(await (await owner.call("GET", userPath)).json()).toMatchObject({
      status: "active",
      locked: true,
    });

    const unlocked = await owner.call("POST", `${userPath}/unlock`);
    expect(unlocked.status).toBe(200);
    expect((await signIn(NEW_PASSWORD)).status).toBe(200);
  });

  it("the pool's events are in its own log, not the workspace's", async () => {
    const poolLog = await owner.call(
      "GET",
      `/workspaces/${workspace}/user-pools/${pool}/audit-events?limit=100`,
    );
    expect(poolLog.status).toBe(200);
    const actions = (
      (await poolLog.json()) as { events: { action: string }[] }
    ).events.map((event) => event.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "pool_user.signed_up",
        "pool_user.logged_in",
        "pool_user.login_failed",
        "pool_user.token_reused",
        "pool_user.password_reset",
        "pool_user.password_changed",
        "pool_user.unlocked",
      ]),
    );

    const chosen = async (query: string) => {
      const response = await owner.call(
        "GET",
        `/workspaces/${workspace}/user-pools/${pool}/audit-events?limit=100&action=pool_user.login_failed&action=pool_user.unlocked${query}`,
      );
      expect(response.status).toBe(200);
      const { events } = (await response.json()) as {
        events: { action: string; outcome: string }[];
      };
      return new Set(events.map((e) => `${e.action} ${e.outcome}`));
    };
    expect(await chosen("&outcome=success&outcome=denied")).toEqual(
      new Set(["pool_user.login_failed denied", "pool_user.unlocked success"]),
    );
    expect(await chosen("&outcome=success")).toEqual(
      new Set(["pool_user.unlocked success"]),
    );

    const workspaceLog = await app("GET", "/audit-events?limit=100");
    expect(workspaceLog.status).toBe(200);
    const workspaceActions = (
      (await workspaceLog.json()) as { events: { action: string }[] }
    ).events.map((event) => event.action);
    expect(workspaceActions).toContain("user_pool.created");
    expect(workspaceActions.some((a) => a.startsWith("pool_user."))).toBe(
      false,
    );

    const audit = psql(
      "audit_app",
      "audit",
      `select count(*) from audit_events where chain = 'pool:${pool}';`,
    );
    expect(audit.ok).toBe(true);
    expect(Number(audit.output.match(/\d+/)?.[0])).toBeGreaterThan(5);
  });

  it("stores only hashes and an encrypted signing key", () => {
    const dump = psql(
      "identity_app",
      "identity",
      "select * from pool_users; select * from pool_sessions; select * from signing_keys;",
    );
    expect(dump.ok).toBe(true);
    expect(dump.output).toContain("$argon2id$");
    for (const secret of [
      END_USER_PASSWORD,
      NEW_PASSWORD,
      tokens.refreshToken,
      "BEGIN PRIVATE KEY",
    ]) {
      expect(dump.output).not.toContain(secret);
    }
    expect(dump.output).not.toMatch(/"d":\s*"/);
  });
});

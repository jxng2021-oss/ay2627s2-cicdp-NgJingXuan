import { createPublicKey, randomBytes, verify } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { freshWindow, GATEWAY_URL, psql } from "./helpers.js";

const ORIGIN = process.env.DASHBOARD_ORIGIN ?? "http://localhost:3000";
const PASSWORD = `e2e-pools-${randomBytes(8).toString("hex")}`;
const END_USER_PASSWORD = `end-user-${randomBytes(8).toString("hex")}`;

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
  user: { id: string; email: string };
}

let pool = "";
let issuer = "";
let apiKey = "";

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
  const owner = new Browser();
  const signUp = await owner.call("POST", "/auth/sign-up", {
    email: `e2e-pools-${randomBytes(4).toString("hex")}@example.test`,
    password: PASSWORD,
    workspaceName: "Pools workspace",
  });
  expect(signUp.status).toBe(201);
  const workspace = ((await signUp.json()) as { workspaces: { id: string }[] })
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

  it("sign-ins and the token reuse are in the workspace's audit log", async () => {
    const events = await app(
      "GET",
      "/audit-events?resourceType=pool_user&limit=50",
    );
    expect(events.status).toBe(200);
    const actions = (
      (await events.json()) as { events: { action: string }[] }
    ).events.map((event) => event.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "pool_user.signed_up",
        "pool_user.logged_in",
        "pool_user.login_failed",
        "pool_user.token_reused",
      ]),
    );
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
      tokens.refreshToken,
      "BEGIN PRIVATE KEY",
    ]) {
      expect(dump.output).not.toContain(secret);
    }
    expect(dump.output).not.toMatch(/"d":\s*"/);
  });
});

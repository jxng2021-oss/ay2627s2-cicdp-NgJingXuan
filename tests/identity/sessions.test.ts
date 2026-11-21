import { describe, expect, it } from "vitest";
import { LOCK_AFTER, LOCK_MS } from "../../services/identity/src/app.js";
import { verifyJwt } from "../../services/identity/src/signing.js";
import {
  call,
  captureLogs,
  createPool,
  newTenant,
  PASSWORD,
  PUBLIC_BASE_URL,
  signUp,
  startIdentity,
  type TestService,
  type Tokens,
} from "./helpers.js";

async function setup(service: TestService) {
  const tenant = newTenant();
  const pool = await createPool(service.app, tenant, {
    name: "Shop",
    accessTokenTtlSeconds: 600,
  });
  const user = await signUp(service.app, tenant, pool, "ada@example.com", {
    attributes: { plan: "pro" },
  });
  const login = (email = "ada@example.com", password = PASSWORD) =>
    call(service.app, tenant, "POST", `/pools/${pool}/sessions`, {
      email,
      password,
    });
  const refresh = (refreshToken: string) =>
    call(service.app, tenant, "POST", `/pools/${pool}/sessions/refresh`, {
      refreshToken,
    });
  const jwks = async () =>
    (
      await service.app.inject({
        method: "GET",
        url: `/public/pools/${pool}/jwks`,
      })
    ).json<{ keys: Record<string, string>[] }>().keys;
  return { tenant, pool, user, login, refresh, jwks };
}

describe("sessions", () => {
  it("signs a user in with a JWT the pool's public key verifies", async () => {
    const service = await startIdentity();
    const { pool, user, login, jwks } = await setup(service);

    const response = await login("ADA@example.com");

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const tokens = response.json<Tokens>();
    expect(tokens).toMatchObject({ tokenType: "Bearer", expiresIn: 600 });
    expect(tokens.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const claims = verifyJwt(tokens.accessToken, await jwks());
    expect(claims).toMatchObject({
      iss: `${PUBLIC_BASE_URL}/v1/user-pools/${pool}`,
      aud: pool,
      sub: user,
      token_use: "access",
      email: "ada@example.com",
      attributes: { plan: "pro" },
    });
    expect(Number(claims!.exp) - Number(claims!.iat)).toBe(600);
    const other = await setup(service);
    const otherTokens = (await other.login()).json<Tokens>();
    expect(verifyJwt(otherTokens.accessToken, await jwks())).toBeUndefined();
    const [h, p, s] = tokens.accessToken.split(".");
    const forged = Buffer.from(p!, "base64url")
      .toString()
      .replace("pro", "max");
    expect(
      verifyJwt(
        `${h}.${Buffer.from(forged).toString("base64url")}.${s}`,
        await jwks(),
      ),
    ).toBeUndefined();
  });

  it("gives the same 401 for a wrong password, an unknown email and a disabled user", async () => {
    const service = await startIdentity();
    const { tenant, pool, user, login } = await setup(service);
    await call(service.app, tenant, "PATCH", `/pools/${pool}/users/${user}`, {
      status: "disabled",
    });
    await signUp(service.app, tenant, pool, "bob@example.com");

    const answers = await Promise.all([
      login("bob@example.com", "wrong-password-123"),
      login("nobody@example.com"),
      login("ada@example.com"),
    ]);

    for (const response of answers) {
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        error: { code: "UNAUTHORIZED", message: "Wrong email or password" },
      });
    }
    const failed = service.audit.events.filter(
      (e) => e.action === "pool_user.login_failed",
    );
    expect(failed).toHaveLength(3);
    expect(JSON.stringify(service.audit.events)).not.toMatch(/@example\.com/);
  });

  it(`locks a user after ${LOCK_AFTER} wrong passwords, even for the right one, until the lock ends`, async () => {
    const service = await startIdentity();
    const { login } = await setup(service);

    for (let i = 0; i < LOCK_AFTER; i++) {
      expect(
        (await login("ada@example.com", "wrong-password-123")).statusCode,
      ).toBe(401);
    }
    expect((await login()).statusCode).toBe(401);

    service.clock.now += LOCK_MS - 1000;
    expect((await login()).statusCode).toBe(401);
    service.clock.now += 2000;
    expect((await login()).statusCode).toBe(200);
  });

  it("a refresh token works once; the new one works; the old one, seen again, ends the session", async () => {
    const service = await startIdentity();
    const { login, refresh, jwks } = await setup(service);
    const first = (await login()).json<Tokens>();

    const second = await refresh(first.refreshToken);
    expect(second.statusCode).toBe(200);
    const renewed = second.json<Tokens>();
    expect(renewed.refreshToken).not.toBe(first.refreshToken);
    expect(verifyJwt(renewed.accessToken, await jwks())).toBeDefined();

    const third = await refresh(renewed.refreshToken);
    expect(third.statusCode).toBe(200);
    const latest = third.json<Tokens>();

    expect((await refresh(first.refreshToken)).statusCode).toBe(401);
    expect((await refresh(latest.refreshToken)).statusCode).toBe(401);
    expect(service.audit.events.map((e) => e.action)).toContain(
      "pool_user.token_reused",
    );
  });

  it("refresh tokens expire, can be revoked, and belong to one pool", async () => {
    const service = await startIdentity();
    const { tenant, pool, login, refresh } = await setup(service);
    const tokens = (await login()).json<Tokens>();
    const other = await setup(service);

    expect((await other.refresh(tokens.refreshToken)).statusCode).toBe(401);

    const revoke = await call(
      service.app,
      tenant,
      "POST",
      `/pools/${pool}/sessions/revoke`,
      {
        refreshToken: tokens.refreshToken,
      },
    );
    expect(revoke.statusCode).toBe(204);
    expect((await refresh(tokens.refreshToken)).statusCode).toBe(401);
    expect(
      (
        await call(
          service.app,
          tenant,
          "POST",
          `/pools/${pool}/sessions/revoke`,
          {
            refreshToken: "x".repeat(43),
          },
        )
      ).statusCode,
    ).toBe(204);

    const later = (await login()).json<Tokens>();
    service.clock.now += 31 * 86_400_000;
    expect((await refresh(later.refreshToken)).statusCode).toBe(401);
  });

  it("while the vault is sealed: sign-up works, sign-in waits (503 SECRETS_SEALED)", async () => {
    const service = await startIdentity();
    const { tenant, pool, login } = await setup(service);
    service.vault.sealed = true;

    const response = await login();
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "SECRETS_SEALED" },
    });
    expect(
      (await signUp(service.app, tenant, pool, "later@example.com")).length,
    ).toBe(36);
  });

  it("never logs or records passwords, tokens or emails", async () => {
    const logs = captureLogs();
    const service = await startIdentity({ logStream: logs.stream });
    const { login, refresh } = await setup(service);
    const tokens = (await login()).json<Tokens>();
    await refresh(tokens.refreshToken);
    await login("ada@example.com", "a-wrong-password-1");

    const recorded = logs.text() + JSON.stringify(service.audit.events);
    expect(logs.text()).toContain("request completed");
    for (const secret of [
      PASSWORD,
      "a-wrong-password-1",
      tokens.accessToken,
      tokens.refreshToken,
      "ada@example.com",
    ]) {
      expect(recorded).not.toContain(secret);
    }
  });
});

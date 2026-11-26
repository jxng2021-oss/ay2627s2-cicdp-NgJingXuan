import { describe, expect, it, vi } from "vitest";
import {
  loadConfig,
  parseOAuth,
  parseTrustProxy,
} from "../../services/gateway/src/config.js";
import { connectDatabase } from "../../services/gateway/src/db/client.js";
import {
  connectRedis,
  RedisRateLimitStore,
} from "../../services/gateway/src/rate-limit.js";

const BASE = {
  DATABASE_URL: "postgres://x",
  REDIS_URL: "redis://x",
  API_KEY_HASH_SECRET: "h".repeat(32),
  AUDIT_TOKEN: "a".repeat(32),
  SESSION_SECRET: "s".repeat(32),
};

describe("more gateway settings", () => {
  it("refuses a badly shaped API key prefix", () => {
    expect(() => loadConfig({ ...BASE, API_KEY_PREFIX: "key-" })).toThrow(
      "API_KEY_PREFIX must look like sk_<letters/digits>_",
    );
  });

  it("refuses a dashboard origin that isn't an origin", () => {
    expect(() =>
      loadConfig({ ...BASE, DASHBOARD_ORIGIN: "not a url" }),
    ).toThrow(
      "DASHBOARD_ORIGIN must be an origin like https://dashboard.example.com",
    );
    expect(() =>
      loadConfig({ ...BASE, DASHBOARD_ORIGIN: "https://dash.example.com/app" }),
    ).toThrow("(no path or trailing slash)");
  });

  it("refuses a gateway origin that isn't an origin", () => {
    expect(() => parseOAuth({ GATEWAY_PUBLIC_ORIGIN: "nope" })).toThrow(
      "GATEWAY_PUBLIC_ORIGIN must be an origin like https://api.example.com",
    );
    expect(() =>
      parseOAuth({ GATEWAY_PUBLIC_ORIGIN: "https://api.example.com/" }),
    ).toThrow("(no path or trailing slash)");
  });

  it("needs https for sign in with Google or GitHub in production", () => {
    expect(() =>
      parseOAuth({
        NODE_ENV: "production",
        GATEWAY_PUBLIC_ORIGIN: "http://api.example.com",
        GITHUB_CLIENT_ID: "id",
        GITHUB_CLIENT_SECRET: "secret",
      }),
    ).toThrow("must use https when Google or GitHub sign in is on");
    expect(
      parseOAuth({
        NODE_ENV: "production",
        GATEWAY_PUBLIC_ORIGIN: "https://api.example.com",
        GOOGLE_CLIENT_ID: " id ",
        GOOGLE_CLIENT_SECRET: " secret ",
      }),
    ).toEqual({
      redirectOrigin: "https://api.example.com",
      google: { clientId: "id", clientSecret: "secret" },
      github: undefined,
    });
  });

  it("needs a client ID and secret together", () => {
    expect(() => parseOAuth({ GOOGLE_CLIENT_ID: "id" })).toThrow(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together",
    );
  });

  it("only trusts the proxies it lists", () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy("false")).toBe(false);
    expect(parseTrustProxy(" 172.30.0.2 , ,10.0.0.1")).toEqual([
      "172.30.0.2",
      "10.0.0.1",
    ]);
    expect(() => parseTrustProxy("true")).toThrow(/TRUST_PROXY=true/);
  });

  it("refuses limits that aren't positive numbers", () => {
    expect(() => loadConfig({ ...BASE, SESSION_ACCESS_TTL_MS: "-1" })).toThrow(
      "SESSION_ACCESS_TTL_MS must be a positive number",
    );
  });

  it("creates database and Redis clients without connecting until used", async () => {
    const { db, close } = connectDatabase("postgres://u:p@127.0.0.1:1/x");
    expect(db).toBeDefined();
    await close();
    const redis = connectRedis("redis://127.0.0.1:1");
    redis.on("error", () => undefined);
    redis.disconnect();
  });
});

function fakeRedis(reply: unknown) {
  const redis = {
    eval: vi.fn(() => Promise.resolve(reply)),
    get: vi.fn(() => Promise.resolve(null as string | null)),
    ping: vi.fn(() => Promise.resolve("PONG")),
  };
  return {
    redis,
    store: new RedisRateLimitStore(
      redis as unknown as ConstructorParameters<typeof RedisRateLimitStore>[0],
    ),
  };
}

describe("the Redis rate limit store", () => {
  it("reads windows from the hit and peek scripts", async () => {
    const { redis, store } = fakeRedis([3, -5]);
    expect(await store.hit("ip:1", 60_000)).toEqual({ count: 3, resetMs: 0 });
    expect(await store.peek("ip:1")).toEqual({ count: 3, resetMs: 0 });
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      "ip:1",
      60_000,
    );
  });

  it("reserves and releases amounts", async () => {
    const { redis, store } = fakeRedis(["1", "250"]);
    expect(await store.reserve("amount:x", 50, 500, 1_000)).toEqual({
      reserved: true,
      total: 250,
    });
    await store.release("amount:x", 50);
    expect(redis.eval).toHaveBeenLastCalledWith(
      expect.any(String),
      1,
      "amount:x",
      50,
    );
  });

  it("reads a total, treating a missing key as zero, and pings", async () => {
    const { redis, store } = fakeRedis(null);
    expect(await store.total("amount:x")).toBe(0);
    redis.get.mockResolvedValueOnce("42");
    expect(await store.total("amount:x")).toBe(42);
    await store.ping();
    expect(redis.ping).toHaveBeenCalled();
  });

  it("refuses replies it doesn't understand", async () => {
    const { store } = fakeRedis("weird");
    await expect(store.hit("k", 1)).rejects.toThrow(
      "Unexpected reply from Redis",
    );
    await expect(store.reserve("k", 1, 2, 3)).rejects.toThrow(
      "Unexpected reply from Redis",
    );
  });
});

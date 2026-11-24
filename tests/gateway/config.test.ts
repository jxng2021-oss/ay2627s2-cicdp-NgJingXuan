import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../services/gateway/src/config.js";

const BASE = {
  DATABASE_URL: "postgres://x",
  REDIS_URL: "redis://x",
  API_KEY_HASH_SECRET: "h".repeat(32),
  AUDIT_TOKEN: "a".repeat(32),
  SESSION_SECRET: "s".repeat(32),
};

describe("dashboard and admin settings", () => {
  it("are safe by default: admin API off, Secure cookies", () => {
    const config = loadConfig(BASE);

    expect(config.adminApiEnabled).toBe(false);
    expect(config.dashboard.session.cookieSecure).toBe(true);
  });

  it("refuse the admin API and insecure cookies when NODE_ENV=production", () => {
    expect(() =>
      loadConfig({
        ...BASE,
        NODE_ENV: "production",
        ADMIN_API_ENABLED: "true",
        ADMIN_TOKEN: "t".repeat(32),
      }),
    ).toThrow(/ADMIN_API_ENABLED/);
    expect(() =>
      loadConfig({
        ...BASE,
        NODE_ENV: "production",
        SESSION_COOKIE_SECURE: "false",
      }),
    ).toThrow(/SESSION_COOKIE_SECURE/);
  });

  it("need an EC P-256 webhook signing key in production; elsewhere one is made at start", () => {
    expect(() => loadConfig({ ...BASE, NODE_ENV: "production" })).toThrow(
      /WEBHOOK_SIGNING_KEY must be set/,
    );
    expect(() =>
      loadConfig({
        ...BASE,
        WEBHOOK_SIGNING_KEY: Buffer.from("not a key").toString("base64"),
      }),
    ).toThrow(/WEBHOOK_SIGNING_KEY/);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "der" })
      .toString("base64");
    expect(() => loadConfig({ ...BASE, WEBHOOK_SIGNING_KEY: rsa })).toThrow(
      /EC P-256/,
    );
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" })
      .privateKey.export({ type: "pkcs8", format: "der" })
      .toString("base64");
    expect(
      loadConfig({ ...BASE, NODE_ENV: "production", WEBHOOK_SIGNING_KEY: ec })
        .webhookSigningKey.asymmetricKeyType,
    ).toBe("ec");
    expect(loadConfig(BASE).webhookSigningKey.asymmetricKeyType).toBe("ec");
  });

  it("need a session secret and a plain origin", () => {
    expect(() => loadConfig({ ...BASE, SESSION_SECRET: "short" })).toThrow(
      /SESSION_SECRET/,
    );
    expect(() =>
      loadConfig({ ...BASE, DASHBOARD_ORIGIN: "https://dash.example.com/app" }),
    ).toThrow(/DASHBOARD_ORIGIN/);
    expect(() => loadConfig({ ...BASE, ADMIN_API_ENABLED: "true" })).toThrow(
      /ADMIN_TOKEN/,
    );
  });
});

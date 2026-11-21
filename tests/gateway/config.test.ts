import { describe, expect, it } from "vitest";
import { loadConfig } from "../../services/gateway/src/config.js";

const BASE = {
  DATABASE_URL: "postgres://x",
  REDIS_URL: "redis://x",
  API_KEY_HASH_SECRET: "h".repeat(32),
  AUDIT_TOKEN: "a".repeat(32),
};

describe("admin settings", () => {
  it("are safe by default: admin API off", () => {
    const config = loadConfig(BASE);

    expect(config.adminApiEnabled).toBe(false);
  });

  it("refuse the admin API when NODE_ENV=production", () => {
    expect(() =>
      loadConfig({
        ...BASE,
        NODE_ENV: "production",
        ADMIN_API_ENABLED: "true",
        ADMIN_TOKEN: "t".repeat(32),
      }),
    ).toThrow(/ADMIN_API_ENABLED/);
  });

  it("need an admin token when the admin API is on", () => {
    expect(() => loadConfig({ ...BASE, ADMIN_API_ENABLED: "true" })).toThrow(
      /ADMIN_TOKEN/,
    );
  });
});

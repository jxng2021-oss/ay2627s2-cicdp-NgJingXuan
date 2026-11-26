import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../../services/audit/src/db/client.js";
import { createTestDatabase, HMAC_KEY, TOKENS } from "./helpers.js";

const state: { db?: Database; closed: number; migrated: number } = {
  closed: 0,
  migrated: 0,
};

vi.mock("../../services/audit/src/db/client.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../services/audit/src/db/client.js")
  >()),
  connectDatabase: () => ({
    db: state.db,
    close: () => {
      state.closed += 1;
      return Promise.resolve();
    },
  }),
}));

vi.mock("drizzle-orm/node-postgres/migrator", () => ({
  migrate: () => {
    state.migrated += 1;
    return Promise.resolve();
  },
}));

class Exit extends Error {
  constructor(readonly code: number | undefined) {
    super(`exit ${code}`);
  }
}

beforeEach(() => {
  vi.resetModules();
  state.closed = 0;
  state.migrated = 0;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Exit(code === undefined ? undefined : Number(code));
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the migrate command", () => {
  it("refuses to run without DATABASE_URL", async () => {
    vi.stubEnv("DATABASE_URL", "");
    await expect(
      import("../../services/audit/src/migrate.js"),
    ).rejects.toMatchObject({ code: 1 });
    expect(state.migrated).toBe(0);
  });

  it("applies the migrations and closes the connection", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://audit_app:pw@postgres:5432/audit");
    await import("../../services/audit/src/migrate.js");
    expect(state.migrated).toBe(1);
    expect(state.closed).toBe(1);
  });
});

describe("the server", () => {
  it("starts with its settings and shuts down cleanly on SIGTERM", async () => {
    state.db = (await createTestDatabase()).db;
    vi.stubEnv("DATABASE_URL", "postgres://audit_app:pw@postgres:5432/audit");
    vi.stubEnv("AUDIT_HMAC_KEY", HMAC_KEY);
    vi.stubEnv("AUDIT_TOKEN_GATEWAY", TOKENS.gateway);
    vi.stubEnv("AUDIT_TOKEN_SECRETS", TOKENS.secrets);
    vi.stubEnv("AUDIT_TOKEN_STORAGE", TOKENS.storage);
    vi.stubEnv("AUDIT_TOKEN_IDENTITY", TOKENS.identity);
    vi.stubEnv("AUDIT_TOKEN_FLAGS", TOKENS.flags);
    vi.stubEnv("HOST", "127.0.0.1");
    vi.stubEnv("AUDIT_PORT", "39103");
    vi.stubEnv("SHUTDOWN_TIMEOUT_MS", "3600000");
    const before = new Set(process.listeners("SIGTERM"));
    const beforeInterrupt = new Set(process.listeners("SIGINT"));
    await import("../../services/audit/src/server.js");
    const response = await fetch("http://127.0.0.1:39103/health", {
      headers: {
        "x-audit-service": "gateway",
        authorization: `Bearer ${TOKENS.gateway}`,
      },
    });
    expect(response.status).toBe(200);
    const shutdown = process
      .listeners("SIGTERM")
      .find((listener) => !before.has(listener));
    expect(shutdown).toBeDefined();
    process.removeListener("SIGTERM", shutdown!);
    for (const listener of process.listeners("SIGINT")) {
      if (!beforeInterrupt.has(listener)) {
        process.removeListener("SIGINT", listener);
      }
    }
    shutdown!("SIGTERM");
    await vi.waitFor(() => expect(state.closed).toBe(1));
  });
});

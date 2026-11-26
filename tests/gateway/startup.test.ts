import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../../services/gateway/src/db/client.js";
import { insertMembership } from "../../services/gateway/src/models/membership.model.js";
import { createTenant } from "../../services/gateway/src/models/platform.model.js";
import { insertUser } from "../../services/gateway/src/models/user.model.js";
import { createTestDatabase } from "./helpers.js";

const state: {
  db?: Database;
  closed: number;
  migrated: number;
  audited: string[];
} = { closed: 0, migrated: 0, audited: [] };

vi.mock("../../services/gateway/src/db/client.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../services/gateway/src/db/client.js")
  >()),
  connectDatabase: () => ({
    db: state.db,
    close: () => {
      state.closed += 1;
      return Promise.resolve();
    },
  }),
}));

vi.mock("../../services/gateway/src/rate-limit.js", async (importOriginal) => {
  const real =
    await importOriginal<
      typeof import("../../services/gateway/src/rate-limit.js")
    >();
  return {
    ...real,
    connectRedis: () =>
      Object.assign(new EventEmitter(), { disconnect: () => undefined }),
    RedisRateLimitStore: real.MemoryRateLimitStore,
  };
});

vi.mock("../../services/gateway/src/audit.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../services/gateway/src/audit.js")
  >()),
  httpAuditTransport: () => ({
    transport: (event: { action: string }) => {
      state.audited.push(event.action);
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
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

let output: string[];
let firstExit: number | undefined;
const originalArgv = process.argv;

beforeEach(() => {
  vi.resetModules();
  state.closed = 0;
  state.migrated = 0;
  state.audited = [];
  output = [];
  const keep = (line: unknown) => {
    output.push(String(line));
  };
  vi.spyOn(console, "log").mockImplementation(keep);
  vi.spyOn(console, "error").mockImplementation(keep);
  vi.spyOn(process, "exit").mockImplementation((code) => {
    const exit = new Exit(code === undefined ? undefined : Number(code));
    firstExit ??= exit.code;
    throw exit;
  });
  vi.stubEnv(
    "DATABASE_URL",
    "postgres://gateway_app:pw@postgres:5432/platform",
  );
  vi.stubEnv("REDIS_URL", "redis://redis:6379");
  vi.stubEnv("API_KEY_HASH_SECRET", "h".repeat(32));
  vi.stubEnv("AUDIT_TOKEN", "a".repeat(32));
  vi.stubEnv("SESSION_SECRET", "s".repeat(32));
});

afterEach(() => {
  process.argv = originalArgv;
  vi.unstubAllEnvs();
});

const entryPoints = {
  migrate: () => import("../../services/gateway/src/migrate.js"),
  "accounts-cli": () => import("../../services/gateway/src/accounts-cli.js"),
  server: () => import("../../services/gateway/src/server.js"),
};

async function run(
  file: keyof typeof entryPoints,
  ...args: string[]
): Promise<number | undefined> {
  vi.resetModules();
  firstExit = undefined;
  process.argv = ["node", file, ...args];
  try {
    await entryPoints[file]();
  } catch (error) {
    if (!(error instanceof Exit)) throw error;
  }
  return firstExit;
}

describe("the migrate command", () => {
  it("refuses to run without DATABASE_URL", async () => {
    vi.stubEnv("DATABASE_URL", "");
    expect(await run("migrate")).toBe(1);
    expect(state.migrated).toBe(0);
  });

  it("applies the migrations and closes the connection", async () => {
    expect(await run("migrate")).toBeUndefined();
    expect(state.migrated).toBe(1);
    expect(state.closed).toBe(1);
  });
});

describe("the accounts command", () => {
  async function seed() {
    state.db = (await createTestDatabase()).db;
    const user = await insertUser(state.db, {
      email: "ada@example.com",
      passwordHash: null,
    });
    const tenant = await createTenant(state.db, "Acme shop");
    return { user: user!, tenant };
  }

  it("shows the usage for an unknown command or bad arguments", async () => {
    expect(await run("accounts-cli", "explode")).toBe(2);
    expect(output.join("\n")).toContain("Usage:");
    const { tenant } = await seed();
    expect(
      await run(
        "accounts-cli",
        "add-member",
        "ada@example.com",
        tenant.id,
        "king",
      ),
    ).toBe(2);
  });

  it("refuses to add members in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(await run("accounts-cli", "add-member", "a@b.c", "x", "owner")).toBe(
      1,
    );
    expect(output.join("\n")).toContain("for local testing only");
  });

  it("adds a member, and refuses a second time", async () => {
    const { tenant } = await seed();
    expect(
      await run(
        "accounts-cli",
        "add-member",
        "ADA@example.com",
        tenant.id,
        "member",
      ),
    ).toBe(0);
    expect(output.join("\n")).toContain(
      `Added ada@example.com to ${tenant.id} as member.`,
    );
    expect(state.audited).toEqual(["membership.added"]);
    expect(
      await run(
        "accounts-cli",
        "add-member",
        "ada@example.com",
        tenant.id,
        "member",
      ),
    ).toBe(1);
    expect(output.join("\n")).toContain("already a member");
  });

  it("says when the user or workspace doesn't exist", async () => {
    await seed();
    expect(
      await run("accounts-cli", "reset-password", "nobody@example.com"),
    ).toBe(1);
    expect(output.join("\n")).toContain(
      "No user with the email nobody@example.com",
    );
    expect(
      await run(
        "accounts-cli",
        "add-member",
        "ada@example.com",
        "3c7d2f0e-1f7a-4c55-9b2c-0d1e2f3a4b5c",
        "owner",
      ),
    ).toBe(1);
    expect(output.join("\n")).toContain("No workspace");
  });

  it("resets a password and shows the new one once", async () => {
    const { user, tenant } = await seed();
    await insertMembership(state.db!, {
      userId: user.id,
      tenantId: tenant.id,
      role: "owner",
    });
    expect(await run("accounts-cli", "reset-password", "ada@example.com")).toBe(
      0,
    );
    expect(output.join("\n")).toMatch(
      /New password for ada@example.com \(shown once; every session was ended\):\n\S{24}/,
    );
    expect(state.closed).toBe(1);
  });
});

describe("the server", () => {
  it("starts with its settings and shuts down cleanly on SIGTERM", async () => {
    state.db = (await createTestDatabase()).db;
    vi.stubEnv("HOST", "127.0.0.1");
    vi.stubEnv("GATEWAY_PORT", "39108");
    vi.stubEnv("SHUTDOWN_TIMEOUT_MS", "3600000");
    const before = new Set(process.listeners("SIGTERM"));
    const beforeInterrupt = new Set(process.listeners("SIGINT"));
    await run("server");
    const response = await fetch("http://127.0.0.1:39108/health");
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

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../../services/audit/src/db/client.js";
import { appendEvent } from "../../services/audit/src/models/event.model.js";
import { createTestDatabase, HMAC_KEY } from "./helpers.js";

const database: { db?: Database } = {};

vi.mock("../../services/audit/src/db/client.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../services/audit/src/db/client.js")
  >()),
  connectDatabase: () => ({ db: database.db, close: () => Promise.resolve() }),
}));

class Exit extends Error {
  constructor(readonly code: number | undefined) {
    super(`exit ${code}`);
  }
}

const originalArgv = process.argv;
let output: string[];

beforeEach(() => {
  vi.resetModules();
  output = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    output.push(line);
  });
  vi.spyOn(console, "error").mockImplementation((line: string) => {
    output.push(line);
  });
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Exit(code === undefined ? undefined : Number(code));
  });
  vi.stubEnv("DATABASE_URL", "postgres://audit_app:pw@postgres:5432/audit");
  vi.stubEnv("AUDIT_HMAC_KEY", HMAC_KEY);
});

afterEach(() => {
  process.argv = originalArgv;
  vi.unstubAllEnvs();
});

async function runVerify(target?: string): Promise<number | undefined> {
  process.argv = ["node", "verify.js", ...(target ? [target] : [])];
  try {
    await import("../../services/audit/src/verify.js");
  } catch (error) {
    if (error instanceof Exit) return error.code;
    throw error;
  }
  return undefined;
}

async function addEvents(tenant: string, count: number) {
  for (let i = 1; i <= count; i++) {
    await appendEvent(database.db!, HMAC_KEY, {
      chain: tenant,
      tenantId: tenant,
      service: "secrets",
      actorType: "api_key",
      actorId: randomUUID(),
      action: "secret.read",
      resourceType: "secret",
      resourceId: `secret-${i}`,
      outcome: "success",
      requestId: randomUUID(),
      sourceIp: "198.51.100.1",
    });
  }
}

describe("the verify command", () => {
  it("shows the usage for a missing or invalid target", async () => {
    expect(await runVerify()).toBe(2);
    expect(await runVerify("not-a-tenant")).toBe(2);
    expect(output.join("\n")).toContain(
      "Usage: node dist/verify.js <platform | tenant-id | --all>",
    );
  });

  it("refuses to run without the database URL or a long enough key", async () => {
    vi.stubEnv("AUDIT_HMAC_KEY", "short");
    expect(await runVerify("--all")).toBe(2);
    expect(output).toContain("DATABASE_URL and AUDIT_HMAC_KEY must be set");
  });

  it("says when there are no entries yet", async () => {
    database.db = (await createTestDatabase()).db;
    expect(await runVerify("--all")).toBe(0);
    expect(output).toContain("No audit entries yet.");
  });

  it("reports every intact chain and exits 0", async () => {
    database.db = (await createTestDatabase()).db;
    const tenant = randomUUID();
    await addEvents(tenant, 3);
    expect(await runVerify(tenant)).toBe(0);
    expect(output).toContain(`OK      ${tenant}: 3 entries intact`);
  });

  it("reports the first broken entry and exits 1", async () => {
    const { db, client } = await createTestDatabase();
    database.db = db;
    const tenant = randomUUID();
    await addEvents(tenant, 3);
    await client.exec(
      `update audit_events set resource_id = 'changed' where chain = '${tenant}' and seq = 2`,
    );
    expect(await runVerify("--all")).toBe(1);
    expect(output.join("\n")).toMatch(
      new RegExp(
        `BROKEN  ${tenant}: first broken entry is #2 .*1 entries before it are intact\\.`,
      ),
    );
  });
});

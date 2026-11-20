import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const POSTGRES_IMAGE = "postgres:18.6-alpine";
const CONTAINER = `scp-database-test-${randomUUID().slice(0, 8)}`;
const SETUP_SQL = readFileSync(
  join(REPO_ROOT, "deploy", "postgres-setup.sql"),
  "utf8",
);
const AUDIT_MIGRATION = readFileSync(
  join(
    REPO_ROOT,
    "services",
    "audit",
    "drizzle",
    "0000_create_audit_events.sql",
  ),
  "utf8",
);

const PASSWORD_SETTINGS = [
  "GATEWAY_DB_PASSWORD",
  "SECRETS_DB_PASSWORD",
  "STORAGE_DB_PASSWORD",
  "AUDIT_MIGRATOR_DB_PASSWORD",
  "AUDIT_DB_PASSWORD",
  "IDENTITY_DB_PASSWORD",
  "FLAGS_DB_PASSWORD",
];

const LOGINS = [
  { login: "gateway_app", database: "platform" },
  { login: "secrets_app", database: "secrets" },
  { login: "storage_app", database: "storage" },
  { login: "audit_app", database: "audit" },
  { login: "identity_app", database: "identity" },
  { login: "flags_app", database: "flags" },
];

interface Result {
  ok: boolean;
  output: string;
}

function docker(
  args: string[],
  input?: string,
  env?: NodeJS.ProcessEnv,
): Result {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    input,
    env: { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  return {
    ok: result.status === 0,
    output: `${result.stdout}${result.stderr}`.trim(),
  };
}

function psql(user: string, database: string, sql: string): Result {
  return docker([
    "exec",
    CONTAINER,
    "psql",
    "-h",
    "127.0.0.1",
    "-U",
    user,
    "-d",
    database,
    "-At",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    sql,
  ]);
}

function runFile(
  user: string,
  database: string,
  sql: string,
  env = {},
): Result {
  const names = Object.keys(env).flatMap((name) => ["-e", name]);
  return docker(
    [
      "exec",
      "-i",
      ...names,
      CONTAINER,
      "psql",
      "-h",
      "127.0.0.1",
      "-U",
      user,
      "-d",
      database,
      "--no-psqlrc",
      "-v",
      "ON_ERROR_STOP=1",
      "-f",
      "-",
    ],
    sql,
    env,
  );
}

function testPasswords(): Record<string, string> {
  return Object.fromEntries(
    PASSWORD_SETTINGS.map((name) => [name, randomBytes(24).toString("hex")]),
  );
}

async function waitUntilReady(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const ready = docker([
      "exec",
      CONTAINER,
      "pg_isready",
      "-h",
      "127.0.0.1",
      "-U",
      "platform",
    ]);
    if (ready.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Postgres did not start in time");
}

const INSERT_EVENT =
  "insert into audit_events (id, chain, seq, occurred_at, service, actor_type, action, resource_type, outcome, prev_hash, hash) values (gen_random_uuid(), 'platform', 1, now(), 'secrets', 'operator', 'kept', 'x', 'success', '0', '0')";

let firstRun: Result;
let secondRun: Result;

beforeAll(async () => {
  const started = docker([
    "run",
    "--detach",
    "--name",
    CONTAINER,
    "--env",
    "POSTGRES_USER=platform",
    "--env",
    "POSTGRES_DB=platform",
    "--env",
    `POSTGRES_PASSWORD=${randomBytes(24).toString("hex")}`,
    POSTGRES_IMAGE,
  ]);
  if (!started.ok)
    throw new Error(`Could not start Postgres: ${started.output}`);
  await waitUntilReady();

  const passwords = testPasswords();
  firstRun = runFile("platform", "platform", SETUP_SQL, passwords);
  const migrated = runFile("audit_migrator", "audit", AUDIT_MIGRATION);
  secondRun = runFile("platform", "platform", SETUP_SQL, passwords);
  if (!migrated.ok)
    throw new Error(`Audit migration failed: ${migrated.output}`);
}, 120_000);

afterAll(() => {
  docker(["rm", "--force", "--volumes", CONTAINER]);
});

describe("the database setup script", () => {
  it("runs, and runs again over existing tables without errors", () => {
    expect(firstRun.ok, firstRun.output).toBe(true);
    expect(secondRun.ok, secondRun.output).toBe(true);
    expect(secondRun.output).toContain(
      "Database logins and permissions are up to date",
    );
  });

  it("stops when a password setting is missing", () => {
    const passwords = testPasswords();
    delete passwords.AUDIT_DB_PASSWORD;

    const result = runFile("platform", "platform", SETUP_SQL, passwords);

    expect(result.ok).toBe(false);
    expect(result.output).toContain("AUDIT_DB_PASSWORD must be set");
  });

  it("makes no login a superuser or able to create roles or databases", () => {
    const roles = psql(
      "platform",
      "platform",
      "select rolname, rolsuper, rolcreaterole, rolcreatedb from pg_roles where rolname in ('gateway_app', 'secrets_app', 'storage_app', 'audit_app', 'audit_migrator', 'identity_app', 'flags_app') order by 1",
    );

    expect(roles.output.split("\n")).toEqual([
      "audit_app|f|f|f",
      "audit_migrator|f|f|f",
      "flags_app|f|f|f",
      "gateway_app|f|f|f",
      "identity_app|f|f|f",
      "secrets_app|f|f|f",
      "storage_app|f|f|f",
    ]);
  });
});

describe("database separation", () => {
  for (const own of LOGINS) {
    it(`${own.login} can connect to its own database`, () => {
      expect(psql(own.login, own.database, "select 1").ok).toBe(true);
    });

    for (const other of LOGINS.filter((login) => login !== own)) {
      it(`${own.login} can't connect to the ${other.database} database`, () => {
        const result = psql(own.login, other.database, "select 1");

        expect(result.ok).toBe(false);
        expect(result.output).toMatch(
          new RegExp(`permission denied for database "${other.database}"`),
        );
      });
    }
  }

  it("the audit migration login can't reach the other services' databases", () => {
    for (const other of LOGINS.filter((login) => login.database !== "audit")) {
      const result = psql("audit_migrator", other.database, "select 1");

      expect(result.ok).toBe(false);
      expect(result.output).toMatch(/permission denied for database/);
    }
  });
});

describe("the audit login", () => {
  it("can add and read audit events", () => {
    expect(psql("audit_app", "audit", INSERT_EVENT).ok).toBe(true);

    const rows = psql("audit_app", "audit", "select action from audit_events");

    expect(rows.ok).toBe(true);
    expect(rows.output).toContain("kept");
  });

  it.each([
    ["update", "update audit_events set outcome = 'denied'"],
    ["delete", "delete from audit_events"],
    ["truncate", "truncate audit_events"],
    ["drop", "drop table audit_events"],
    ["create a table", "create table rewritten (id int)"],
  ])("can't %s", (_, sql) => {
    const result = psql("audit_app", "audit", sql);

    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/permission denied|must be owner/);
  });
});

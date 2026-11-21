import { describe, expect, it } from "vitest";
import { psql } from "./helpers.js";

const LOGINS = [
  { login: "gateway_app", database: "platform", table: "api_keys" },
  { login: "secrets_app", database: "secrets", table: "tenant_keys" },
  { login: "storage_app", database: "storage", table: "files" },
  { login: "audit_app", database: "audit", table: "audit_events" },
  { login: "identity_app", database: "identity", table: "pool_users" },
  { login: "flags_app", database: "flags", table: "flags" },
];

describe("database separation", () => {
  for (const own of LOGINS) {
    for (const other of LOGINS.filter((l) => l !== own)) {
      it(`${own.login} can't connect to the ${other.database} database`, () => {
        const result = psql(
          own.login,
          other.database,
          `select count(*) from ${other.table}`,
        );

        expect(result.ok).toBe(false);
        expect(result.output).toMatch(
          new RegExp(`permission denied for database "${other.database}"`),
        );
      });
    }
  }

  it("the audit migration login can't reach the other databases", () => {
    for (const database of [
      "platform",
      "secrets",
      "storage",
      "identity",
      "flags",
    ]) {
      const result = psql("audit_migrator", database, "select 1");
      expect(result.ok).toBe(false);
      expect(result.output).toMatch(/permission denied for database/);
    }
  });

  it("each login can use its own tables", () => {
    for (const { login, database, table } of LOGINS) {
      expect(
        psql(login, database, `select count(*) >= 0 from ${table}`),
      ).toEqual({ ok: true, output: "t" });
    }
  });

  it("no login is a superuser, and the gateway's can't change its schema", () => {
    const roles = psql(
      "platform",
      "platform",
      "select rolname, rolsuper, rolcreaterole, rolcreatedb from pg_roles where rolname in ('gateway_app', 'secrets_app', 'storage_app', 'audit_app', 'audit_migrator', 'identity_app', 'flags_app') order by 1",
    );
    const createTable = psql(
      "gateway_app",
      "platform",
      "create table not_allowed (id int)",
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
    expect(createTable.ok).toBe(false);
    expect(createTable.output).toMatch(/permission denied for schema public/);
  });
});

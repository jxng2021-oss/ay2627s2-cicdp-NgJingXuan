import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "../../services/identity/src/db/schema.js";

function foreignKeys(): string[] {
  return Object.values(schema)
    .flatMap((value) => (value instanceof PgTable ? [value] : []))
    .flatMap((table) => {
      const config = getTableConfig(table);
      return config.foreignKeys.map((key) => {
        const reference = key.reference();
        const from = reference.columns.map((column) => column.name).join(",");
        const to = getTableConfig(reference.foreignTable).name;
        const columns = reference.foreignColumns
          .map((column) => column.name)
          .join(",");
        return `${config.name}.${from} -> ${to}.${columns} (${key.onDelete ?? "no action"})`;
      });
    })
    .sort();
}

describe("database schema", () => {
  it("links each table to its parent with the intended delete rule", () => {
    expect(foreignKeys()).toEqual([
      "pool_roles.pool_id -> pools.id (cascade)",
      "pool_sessions.pool_id -> pools.id (cascade)",
      "pool_sessions.user_id -> pool_users.id (cascade)",
      "pool_user_roles.role_id -> pool_roles.id (cascade)",
      "pool_user_roles.user_id -> pool_users.id (cascade)",
      "pool_users.pool_id -> pools.id (cascade)",
      "signing_keys.pool_id -> pools.id (cascade)",
      "used_refresh_tokens.session_id -> pool_sessions.id (cascade)",
    ]);
  });
});

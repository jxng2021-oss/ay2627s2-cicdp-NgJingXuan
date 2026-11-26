import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "../../services/gateway/src/db/schema.js";

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
      "api_keys.tenant_id -> tenants.id (restrict)",
      "memberships.tenant_id -> tenants.id (restrict)",
      "memberships.user_id -> users.id (cascade)",
      "oauth_identities.user_id -> users.id (cascade)",
      "proxy_connections.tenant_id -> tenants.id (restrict)",
      "sessions.user_id -> users.id (cascade)",
      "webhook_endpoints.tenant_id -> tenants.id (cascade)",
      "webhook_events.endpoint_id -> webhook_endpoints.id (cascade)",
      "webhook_events.tenant_id -> tenants.id (cascade)",
    ]);
  });
});

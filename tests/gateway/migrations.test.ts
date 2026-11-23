import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER } from "../../services/gateway/src/db/client.js";
import * as schema from "../../services/gateway/src/db/schema.js";
import { tenants } from "../../services/gateway/src/db/schema.js";

let client: PGlite;
afterEach(async () => {
  await client.close();
});

function freshDatabase() {
  client = new PGlite();
  return drizzle(client, { schema });
}

async function tableNames(): Promise<string[]> {
  const result = await client.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'public' order by 1",
  );
  return result.rows.map((r) => r.table_name);
}

describe("database migrations", () => {
  it("create every table on an empty database", async () => {
    const db = freshDatabase();
    expect(await tableNames()).toEqual([]);

    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    expect(await tableNames()).toEqual([
      "api_keys",
      "memberships",
      "oauth_identities",
      "proxy_connections",
      "sessions",
      "tenants",
      "users",
    ]);
  });

  it("run again on an existing database without changing its data", async () => {
    const db = freshDatabase();
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await db.insert(tenants).values({ name: "Existing tenant" });
    const applied = await client.query(
      "select * from drizzle.__drizzle_migrations",
    );

    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    expect(await db.select({ name: tenants.name }).from(tenants)).toEqual([
      { name: "Existing tenant" },
    ]);
    const appliedAgain = await client.query(
      "select * from drizzle.__drizzle_migrations",
    );
    expect(appliedAgain.rows).toEqual(applied.rows);
  });
});

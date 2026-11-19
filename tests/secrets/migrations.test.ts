import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER } from "../../services/secrets/src/db/client.js";
import * as schema from "../../services/secrets/src/db/schema.js";

let client: PGlite;
afterEach(async () => {
  await client.close();
});

async function tableNames(): Promise<string[]> {
  const result = await client.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'public' order by 1",
  );
  return result.rows.map((r) => r.table_name);
}

describe("secrets database migrations", () => {
  it("create the secrets tables (and nothing of the gateway's)", async () => {
    client = new PGlite();
    await migrate(drizzle(client, { schema }), {
      migrationsFolder: MIGRATIONS_FOLDER,
    });

    expect(await tableNames()).toEqual([
      "seal_config",
      "secret_versions",
      "secrets",
      "shredded_tenants",
      "tenant_keys",
    ]);
  });

  it("run again without changing anything", async () => {
    client = new PGlite();
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await client.query(
      "insert into secrets (tenant_id, name, latest_version) values (gen_random_uuid(), 'kept', 1)",
    );

    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    const rows = await client.query("select name from secrets");
    expect(rows.rows).toEqual([{ name: "kept" }]);
  });
});

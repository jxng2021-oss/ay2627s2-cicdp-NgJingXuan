import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER } from "../../services/audit/src/db/client.js";
import * as schema from "../../services/audit/src/db/schema.js";

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

describe("audit database migrations", () => {
  it("create only the audit table", async () => {
    client = new PGlite();
    await migrate(drizzle(client, { schema }), {
      migrationsFolder: MIGRATIONS_FOLDER,
    });

    expect(await tableNames()).toEqual(["audit_events"]);
  });

  it("run again without changing anything", async () => {
    client = new PGlite();
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await client.query(
      "insert into audit_events (id, chain, seq, occurred_at, service, actor_type, action, resource_type, outcome, prev_hash, hash) values (gen_random_uuid(), 'platform', 1, now(), 'secrets', 'operator', 'kept', 'x', 'success', '0', '0')",
    );

    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    const rows = await client.query("select action from audit_events");
    expect(rows.rows).toEqual([{ action: "kept" }]);
  });
});

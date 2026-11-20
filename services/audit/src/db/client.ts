import { fileURLToPath } from "node:url";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export const MIGRATIONS_FOLDER = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);

export function connectDatabase(databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  return {
    db: drizzle(pool, { schema }),
    close: () => pool.end(),
  };
}

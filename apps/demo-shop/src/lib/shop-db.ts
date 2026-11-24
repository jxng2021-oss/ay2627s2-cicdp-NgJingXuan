import { Pool } from "pg";
import { ORDERS_SCHEMA, type Db } from "./orders";

export class ShopDatabaseMissing extends Error {}

let pool: Pool | undefined;
let ready: Promise<unknown> | undefined;

export async function shopDb(): Promise<Db> {
  const url = process.env.SHOP_DATABASE_URL;
  if (!url) {
    throw new ShopDatabaseMissing(
      "SHOP_DATABASE_URL isn't set: the demo shop's own database is missing.",
    );
  }
  pool ??= new Pool({ connectionString: url, max: 5 });
  ready ??= pool.query(ORDERS_SCHEMA).catch((error: unknown) => {
    ready = undefined;
    throw error;
  });
  await ready;
  const connected = pool;
  return { query: (text, params) => connected.query(text, params) };
}

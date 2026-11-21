import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { flags, type Flag } from "../db/schema.js";

export type Queryable = Pick<
  Database,
  "select" | "insert" | "update" | "delete" | "execute"
>;

export function listFlags(
  db: Queryable,
  tenantId: string,
  keys?: string[],
): Promise<Flag[]> {
  const conditions = [eq(flags.tenantId, tenantId)];
  if (keys) conditions.push(inArray(flags.key, keys));
  return db
    .select()
    .from(flags)
    .where(and(...conditions))
    .orderBy(flags.key);
}

export async function findFlag(
  db: Queryable,
  tenantId: string,
  key: string,
): Promise<Flag | undefined> {
  const [flag] = await db
    .select()
    .from(flags)
    .where(and(eq(flags.tenantId, tenantId), eq(flags.key, key)));
  return flag;
}

export async function insertFlag(
  db: Queryable,
  values: typeof flags.$inferInsert,
): Promise<Flag | undefined> {
  const [flag] = await db
    .insert(flags)
    .values(values)
    .onConflictDoNothing({ target: [flags.tenantId, flags.key] })
    .returning();
  return flag;
}

export async function updateFlag(
  db: Queryable,
  tenantId: string,
  key: string,
  changes: Partial<Pick<Flag, "description" | "environments">>,
): Promise<Flag | undefined> {
  const [flag] = await db
    .update(flags)
    .set({ ...changes, updatedAt: sql`now()` })
    .where(and(eq(flags.tenantId, tenantId), eq(flags.key, key)))
    .returning();
  return flag;
}

export async function deleteFlag(
  db: Queryable,
  tenantId: string,
  key: string,
): Promise<string | undefined> {
  const [row] = await db
    .delete(flags)
    .where(and(eq(flags.tenantId, tenantId), eq(flags.key, key)))
    .returning({ id: flags.id });
  return row?.id;
}

export async function deleteTenantFlags(
  db: Queryable,
  tenantId: string,
): Promise<void> {
  await db.delete(flags).where(eq(flags.tenantId, tenantId));
}

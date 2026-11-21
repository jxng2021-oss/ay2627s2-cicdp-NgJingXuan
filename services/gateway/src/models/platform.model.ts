import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { apiKeys, tenants, type ApiKey, type Tenant } from "../db/schema.js";

export function createTenant(db: Database, name: string): Promise<Tenant> {
  return db
    .insert(tenants)
    .values({ name })
    .returning()
    .then(([tenant]) => required(tenant));
}

export async function findTenant(
  db: Database,
  id: string,
): Promise<Tenant | undefined> {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, id));
  return tenant;
}

export async function suspendTenant(
  db: Database,
  id: string,
): Promise<Tenant | undefined> {
  const [tenant] = await db
    .update(tenants)
    .set({ status: "suspended", updatedAt: new Date() })
    .where(eq(tenants.id, id))
    .returning();
  return tenant;
}

export function insertApiKey(
  db: Database,
  values: Pick<ApiKey, "tenantId" | "name" | "lookupPrefix" | "secretHash">,
): Promise<ApiKey> {
  return db
    .insert(apiKeys)
    .values(values)
    .returning()
    .then(([key]) => required(key));
}

export function listApiKeys(db: Database, tenantId: string): Promise<ApiKey[]> {
  return db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.tenantId, tenantId))
    .orderBy(apiKeys.createdAt);
}

export async function revokeApiKey(
  db: Database,
  tenantId: string,
  keyId: string,
): Promise<boolean> {
  const updated = await db
    .update(apiKeys)
    .set({
      status: "revoked",
      revokedAt: sql`coalesce(${apiKeys.revokedAt}, now())`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.tenantId, tenantId)))
    .returning({ id: apiKeys.id });
  return updated.length > 0;
}

export async function findKeyForAuthentication(
  db: Database,
  lookupPrefix: string,
): Promise<{ key: ApiKey; tenant: Tenant } | undefined> {
  const [row] = await db
    .select({ key: apiKeys, tenant: tenants })
    .from(apiKeys)
    .innerJoin(tenants, eq(apiKeys.tenantId, tenants.id))
    .where(eq(apiKeys.lookupPrefix, lookupPrefix));
  return row;
}

export async function touchApiKey(db: Database, keyId: string): Promise<void> {
  await db
    .update(apiKeys)
    .set({ lastUsedAt: sql`now()` })
    .where(
      and(
        eq(apiKeys.id, keyId),
        or(
          isNull(apiKeys.lastUsedAt),
          lt(apiKeys.lastUsedAt, sql`now() - interval '1 minute'`),
        ),
      ),
    );
}

function required<T>(row: T | undefined): T {
  if (row === undefined)
    throw new Error("Expected the database to return a row");
  return row;
}

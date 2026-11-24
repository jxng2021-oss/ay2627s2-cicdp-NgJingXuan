import { and, eq, getTableColumns, isNull, lt, or, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import {
  apiKeys,
  proxyConnections,
  tenants,
  type ApiKey,
  type ProxyConnection,
  type Tenant,
} from "../db/schema.js";

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

export async function deleteRevokedApiKey(
  db: Database,
  tenantId: string,
  keyId: string,
): Promise<"deleted" | "active" | "missing"> {
  const deleted = await db
    .delete(apiKeys)
    .where(
      and(
        eq(apiKeys.id, keyId),
        eq(apiKeys.tenantId, tenantId),
        eq(apiKeys.status, "revoked"),
      ),
    )
    .returning({ id: apiKeys.id });
  if (deleted.length > 0) return "deleted";
  const found = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.tenantId, tenantId)));
  return found.length > 0 ? "active" : "missing";
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

export type ProxyConnectionSettings = Pick<
  ProxyConnection,
  "baseUrl" | "secretName" | "headerName" | "headerPrefix" | "policy"
>;

export async function saveProxyConnection(
  db: Database,
  tenantId: string,
  name: string,
  settings: ProxyConnectionSettings,
): Promise<{ connection: ProxyConnection; created: boolean }> {
  const [row] = await db
    .insert(proxyConnections)
    .values({ tenantId, name, ...settings })
    .onConflictDoUpdate({
      target: [proxyConnections.tenantId, proxyConnections.name],
      set: { ...settings, updatedAt: sql`now()` },
    })
    .returning({
      ...getTableColumns(proxyConnections),
      created: sql<boolean>`(xmax = 0)`,
    });
  const { created, ...connection } = required(row);
  return { connection, created };
}

export function listProxyConnections(
  db: Database,
  tenantId: string,
): Promise<ProxyConnection[]> {
  return db
    .select()
    .from(proxyConnections)
    .where(eq(proxyConnections.tenantId, tenantId))
    .orderBy(proxyConnections.name);
}

export async function findProxyConnection(
  db: Database,
  tenantId: string,
  name: string,
): Promise<ProxyConnection | undefined> {
  const [row] = await db
    .select()
    .from(proxyConnections)
    .where(
      and(
        eq(proxyConnections.tenantId, tenantId),
        eq(proxyConnections.name, name),
      ),
    );
  return row;
}

export async function deleteProxyConnection(
  db: Database,
  tenantId: string,
  name: string,
): Promise<boolean> {
  const deleted = await db
    .delete(proxyConnections)
    .where(
      and(
        eq(proxyConnections.tenantId, tenantId),
        eq(proxyConnections.name, name),
      ),
    )
    .returning({ id: proxyConnections.id });
  return deleted.length > 0;
}

import { and, asc, count, desc, eq, gt, lt, sql } from "drizzle-orm";
import type { EncryptedData } from "../crypto/envelope.js";
import type { Database } from "../db/client.js";
import {
  sealConfig,
  secrets,
  secretVersions,
  shreddedTenants,
  tenantKeys,
  type SealConfigRow,
  type SecretRow,
  type TenantKeyRow,
} from "../db/schema.js";

type Queryable = Pick<Database, "select" | "insert" | "update" | "delete">;

export function tenantKeyData(row: TenantKeyRow): EncryptedData {
  return {
    formatVersion: row.formatVersion,
    keyVersion: row.masterKeyVersion,
    nonce: row.nonce,
    ciphertext: row.ciphertext,
    authTag: row.authTag,
  };
}

export async function findActiveTenantKey(
  db: Queryable,
  tenantId: string,
): Promise<TenantKeyRow | undefined> {
  const [row] = await db
    .select()
    .from(tenantKeys)
    .where(
      and(eq(tenantKeys.tenantId, tenantId), eq(tenantKeys.status, "active")),
    );
  return row;
}

export async function findTenantKey(
  db: Queryable,
  tenantId: string,
  keyVersion: number,
): Promise<TenantKeyRow | undefined> {
  const [row] = await db
    .select()
    .from(tenantKeys)
    .where(
      and(
        eq(tenantKeys.tenantId, tenantId),
        eq(tenantKeys.keyVersion, keyVersion),
      ),
    );
  return row;
}

export async function insertTenantKeyIfMissing(
  db: Queryable,
  tenantId: string,
  keyVersion: number,
  data: EncryptedData,
): Promise<void> {
  await db
    .insert(tenantKeys)
    .values({
      tenantId,
      keyVersion,
      status: "active",
      formatVersion: data.formatVersion,
      masterKeyVersion: data.keyVersion,
      nonce: data.nonce,
      ciphertext: data.ciphertext,
      authTag: data.authTag,
    })
    .onConflictDoNothing();
}

export async function reserveNextVersion(
  tx: Queryable,
  tenantId: string,
  name: string,
): Promise<SecretRow> {
  const [row] = await tx
    .insert(secrets)
    .values({ tenantId, name, latestVersion: 1 })
    .onConflictDoUpdate({
      target: [secrets.tenantId, secrets.name],
      set: {
        latestVersion: sql`${secrets.latestVersion} + 1`,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  if (!row) throw new Error("reserving a secret version returned no row");
  return row;
}

export async function reserveNextVersionOfExisting(
  tx: Queryable,
  tenantId: string,
  name: string,
): Promise<SecretRow | undefined> {
  const [row] = await tx
    .update(secrets)
    .set({
      latestVersion: sql`${secrets.latestVersion} + 1`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(secrets.tenantId, tenantId), eq(secrets.name, name)))
    .returning();
  return row;
}

export async function insertVersion(
  tx: Queryable,
  secretId: string,
  version: number,
  data: EncryptedData,
): Promise<Date> {
  const [row] = await tx
    .insert(secretVersions)
    .values({
      secretId,
      version,
      tenantKeyVersion: data.keyVersion,
      formatVersion: data.formatVersion,
      nonce: data.nonce,
      ciphertext: data.ciphertext,
      authTag: data.authTag,
    })
    .returning({ createdAt: secretVersions.createdAt });
  if (!row) throw new Error("saving a secret version returned no row");
  return row.createdAt;
}

export async function findSecret(
  db: Queryable,
  tenantId: string,
  name: string,
): Promise<SecretRow | undefined> {
  const [row] = await db
    .select()
    .from(secrets)
    .where(and(eq(secrets.tenantId, tenantId), eq(secrets.name, name)));
  return row;
}

export async function findVersion(
  db: Queryable,
  secretId: string,
  version: number,
) {
  const [row] = await db
    .select()
    .from(secretVersions)
    .where(
      and(
        eq(secretVersions.secretId, secretId),
        eq(secretVersions.version, version),
      ),
    );
  return row;
}

export async function listSecrets(
  db: Queryable,
  tenantId: string,
  limit: number,
  afterName: string | undefined,
) {
  return db
    .select({
      name: secrets.name,
      latestVersion: secrets.latestVersion,
      createdAt: secrets.createdAt,
      updatedAt: secrets.updatedAt,
    })
    .from(secrets)
    .where(
      and(
        eq(secrets.tenantId, tenantId),
        afterName === undefined ? undefined : gt(secrets.name, afterName),
      ),
    )
    .orderBy(asc(secrets.name))
    .limit(limit);
}

export async function listVersions(
  db: Queryable,
  secretId: string,
  limit: number,
  beforeVersion: number | undefined,
) {
  return db
    .select({
      version: secretVersions.version,
      createdAt: secretVersions.createdAt,
    })
    .from(secretVersions)
    .where(
      and(
        eq(secretVersions.secretId, secretId),
        beforeVersion === undefined
          ? undefined
          : lt(secretVersions.version, beforeVersion),
      ),
    )
    .orderBy(desc(secretVersions.version))
    .limit(limit);
}

export async function deleteSecret(
  db: Queryable,
  tenantId: string,
  name: string,
): Promise<boolean> {
  const deleted = await db
    .delete(secrets)
    .where(and(eq(secrets.tenantId, tenantId), eq(secrets.name, name)))
    .returning({ id: secrets.id });
  return deleted.length > 0;
}

export async function shredTenant(
  db: Queryable,
  tenantId: string,
): Promise<void> {
  await db.insert(shreddedTenants).values({ tenantId }).onConflictDoNothing();
  await db.delete(secrets).where(eq(secrets.tenantId, tenantId));
  await db.delete(tenantKeys).where(eq(tenantKeys.tenantId, tenantId));
}

export async function isTenantShredded(
  db: Queryable,
  tenantId: string,
): Promise<boolean> {
  const rows = await db
    .select({ tenantId: shreddedTenants.tenantId })
    .from(shreddedTenants)
    .where(eq(shreddedTenants.tenantId, tenantId));
  return rows.length > 0;
}

export async function findSealConfig(
  db: Queryable,
): Promise<SealConfigRow | undefined> {
  const [row] = await db.select().from(sealConfig);
  return row;
}

export async function insertSealConfig(
  db: Queryable,
  row: Omit<SealConfigRow, "id" | "createdAt">,
): Promise<boolean> {
  const inserted = await db
    .insert(sealConfig)
    .values({ ...row, id: 1 })
    .onConflictDoNothing()
    .returning({ id: sealConfig.id });
  return inserted.length > 0;
}

export async function hasEncryptedData(db: Queryable): Promise<boolean> {
  const [keys] = await db.select({ n: count() }).from(tenantKeys);
  const [stored] = await db.select({ n: count() }).from(secrets);
  return (keys?.n ?? 0) > 0 || (stored?.n ?? 0) > 0;
}

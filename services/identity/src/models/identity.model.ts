import {
  and,
  count,
  desc,
  eq,
  inArray,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Database } from "../db/client.js";
import {
  poolRoles,
  pools,
  poolSessions,
  poolUserRoles,
  poolUsers,
  signingKeys,
  usedRefreshTokens,
  type Pool,
  type PoolRole,
  type PoolSession,
  type PoolUser,
  type SigningKey,
} from "../db/schema.js";

export type Queryable = Pick<
  Database,
  "select" | "insert" | "update" | "delete" | "execute"
>;

export async function insertPool(
  db: Queryable,
  pool: typeof pools.$inferInsert,
  key: typeof signingKeys.$inferInsert,
): Promise<Pool> {
  const [saved] = await db.insert(pools).values(pool).returning();
  await db.insert(signingKeys).values(key);
  return saved!;
}

export async function listPools(
  db: Queryable,
  tenantId: string,
): Promise<(Pool & { userCount: number })[]> {
  const rows = await db
    .select({ pool: pools, userCount: count(poolUsers.id) })
    .from(pools)
    .leftJoin(poolUsers, eq(poolUsers.poolId, pools.id))
    .where(eq(pools.tenantId, tenantId))
    .groupBy(pools.id)
    .orderBy(pools.name);
  return rows.map((row) => ({ ...row.pool, userCount: row.userCount }));
}

export async function findPool(
  db: Queryable,
  tenantId: string,
  poolId: string,
): Promise<(Pool & { userCount: number }) | undefined> {
  const [row] = await db
    .select({ pool: pools, userCount: count(poolUsers.id) })
    .from(pools)
    .leftJoin(poolUsers, eq(poolUsers.poolId, pools.id))
    .where(and(eq(pools.tenantId, tenantId), eq(pools.id, poolId)))
    .groupBy(pools.id);
  return row ? { ...row.pool, userCount: row.userCount } : undefined;
}

export async function updatePool(
  db: Queryable,
  tenantId: string,
  poolId: string,
  changes: Partial<
    Pick<
      Pool,
      | "name"
      | "accessTokenTtlSeconds"
      | "refreshTokenTtlSeconds"
      | "minPasswordLength"
    >
  >,
): Promise<boolean> {
  const rows = await db
    .update(pools)
    .set(changes)
    .where(and(eq(pools.tenantId, tenantId), eq(pools.id, poolId)))
    .returning({ id: pools.id });
  return rows.length === 1;
}

export async function deletePool(
  db: Queryable,
  tenantId: string,
  poolId: string,
): Promise<boolean> {
  const rows = await db
    .delete(pools)
    .where(and(eq(pools.tenantId, tenantId), eq(pools.id, poolId)))
    .returning({ id: pools.id });
  return rows.length === 1;
}

export async function deleteTenantPools(
  db: Queryable,
  tenantId: string,
): Promise<string[]> {
  const rows = await db
    .delete(pools)
    .where(eq(pools.tenantId, tenantId))
    .returning({ id: pools.id });
  return rows.map((row) => row.id);
}

export async function findSigningKey(
  db: Queryable,
  poolId: string,
): Promise<SigningKey | undefined> {
  const [key] = await db
    .select()
    .from(signingKeys)
    .where(eq(signingKeys.poolId, poolId))
    .orderBy(desc(signingKeys.createdAt))
    .limit(1);
  return key;
}

export async function publicKeys(
  db: Queryable,
  poolId: string,
): Promise<Record<string, string>[] | undefined> {
  const [pool] = await db
    .select({ id: pools.id })
    .from(pools)
    .where(eq(pools.id, poolId));
  if (!pool) return undefined;
  const keys = await db
    .select({ jwk: signingKeys.publicJwk })
    .from(signingKeys)
    .where(eq(signingKeys.poolId, poolId));
  return keys.map((key) => key.jwk);
}

export async function insertUser(
  db: Queryable,
  values: typeof poolUsers.$inferInsert,
): Promise<PoolUser | undefined> {
  const [user] = await db
    .insert(poolUsers)
    .values(values)
    .onConflictDoNothing({ target: [poolUsers.poolId, poolUsers.email] })
    .returning();
  return user;
}

export async function listUsers(
  db: Queryable,
  poolId: string,
  options: { limit: number; cursor?: string; email?: string },
): Promise<PoolUser[]> {
  const conditions: SQL[] = [eq(poolUsers.poolId, poolId)];
  if (options.email) {
    const escaped = options.email.toLowerCase().replace(/[\\%_]/g, "\\$&");
    conditions.push(sql`${poolUsers.email} like ${`%${escaped}%`}`);
  }
  if (options.cursor) {
    const [after] = await db
      .select({ createdAt: poolUsers.createdAt, id: poolUsers.id })
      .from(poolUsers)
      .where(
        and(eq(poolUsers.poolId, poolId), eq(poolUsers.id, options.cursor)),
      );
    if (after) {
      conditions.push(
        or(
          lt(poolUsers.createdAt, after.createdAt),
          and(
            eq(poolUsers.createdAt, after.createdAt),
            lt(poolUsers.id, after.id),
          ),
        )!,
      );
    }
  }
  return db
    .select()
    .from(poolUsers)
    .where(and(...conditions))
    .orderBy(desc(poolUsers.createdAt), desc(poolUsers.id))
    .limit(options.limit);
}

export async function findUser(
  db: Queryable,
  poolId: string,
  userId: string,
): Promise<PoolUser | undefined> {
  const [user] = await db
    .select()
    .from(poolUsers)
    .where(and(eq(poolUsers.poolId, poolId), eq(poolUsers.id, userId)));
  return user;
}

export async function findUserByEmail(
  db: Queryable,
  poolId: string,
  email: string,
): Promise<PoolUser | undefined> {
  const [user] = await db
    .select()
    .from(poolUsers)
    .where(and(eq(poolUsers.poolId, poolId), eq(poolUsers.email, email)));
  return user;
}

export async function updateUser(
  db: Queryable,
  poolId: string,
  userId: string,
  changes: Partial<
    Pick<
      PoolUser,
      "status" | "attributes" | "passwordHash" | "failedLogins" | "lockedUntil"
    >
  >,
): Promise<PoolUser | undefined> {
  const [user] = await db
    .update(poolUsers)
    .set(changes)
    .where(and(eq(poolUsers.poolId, poolId), eq(poolUsers.id, userId)))
    .returning();
  return user;
}

export async function deleteUser(
  db: Queryable,
  poolId: string,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .delete(poolUsers)
    .where(and(eq(poolUsers.poolId, poolId), eq(poolUsers.id, userId)))
    .returning({ id: poolUsers.id });
  return rows.length === 1;
}

export async function recordFailedLogin(
  db: Queryable,
  userId: string,
  lockAfter: number,
  lockUntil: Date,
): Promise<void> {
  await db
    .update(poolUsers)
    .set({
      failedLogins: sql`${poolUsers.failedLogins} + 1`,
      lockedUntil: sql`case when ${poolUsers.failedLogins} + 1 >= ${lockAfter}
        then ${lockUntil.toISOString()}::timestamptz
        else ${poolUsers.lockedUntil} end`,
    })
    .where(eq(poolUsers.id, userId));
}

export async function recordLogin(
  db: Queryable,
  userId: string,
): Promise<void> {
  await db
    .update(poolUsers)
    .set({ failedLogins: 0, lockedUntil: null, lastLoginAt: sql`now()` })
    .where(eq(poolUsers.id, userId));
}

export async function insertSession(
  db: Queryable,
  values: typeof poolSessions.$inferInsert,
): Promise<PoolSession> {
  const [session] = await db.insert(poolSessions).values(values).returning();
  return session!;
}

export async function findSessionByRefresh(
  db: Queryable,
  poolId: string,
  refreshHash: string,
): Promise<{ session: PoolSession; used: boolean } | undefined> {
  const [current] = await db
    .select()
    .from(poolSessions)
    .where(
      and(
        eq(poolSessions.poolId, poolId),
        eq(poolSessions.refreshHash, refreshHash),
      ),
    );
  if (current) return { session: current, used: false };
  const [old] = await db
    .select({ session: poolSessions })
    .from(usedRefreshTokens)
    .innerJoin(poolSessions, eq(poolSessions.id, usedRefreshTokens.sessionId))
    .where(
      and(
        eq(usedRefreshTokens.hash, refreshHash),
        eq(poolSessions.poolId, poolId),
      ),
    );
  return old ? { session: old.session, used: true } : undefined;
}

export async function rotateSession(
  db: Queryable,
  sessionId: string,
  oldHash: string,
  newHash: string,
): Promise<boolean> {
  const rows = await db
    .update(poolSessions)
    .set({ refreshHash: newHash, lastUsedAt: sql`now()` })
    .where(
      and(
        eq(poolSessions.id, sessionId),
        eq(poolSessions.refreshHash, oldHash),
        eq(poolSessions.revoked, false),
      ),
    )
    .returning({ id: poolSessions.id });
  if (rows.length !== 1) return false;
  await db.insert(usedRefreshTokens).values({ hash: oldHash, sessionId });
  return true;
}

export async function revokeSession(
  db: Queryable,
  sessionId: string,
): Promise<void> {
  await db
    .update(poolSessions)
    .set({ revoked: true })
    .where(eq(poolSessions.id, sessionId));
}

export async function revokeUserSessions(
  db: Queryable,
  userId: string,
): Promise<void> {
  await db
    .update(poolSessions)
    .set({ revoked: true })
    .where(
      and(eq(poolSessions.userId, userId), eq(poolSessions.revoked, false)),
    );
}

export async function listRoles(
  db: Queryable,
  poolId: string,
): Promise<(PoolRole & { userCount: number })[]> {
  const rows = await db
    .select({ role: poolRoles, userCount: count(poolUserRoles.userId) })
    .from(poolRoles)
    .leftJoin(poolUserRoles, eq(poolUserRoles.roleId, poolRoles.id))
    .where(eq(poolRoles.poolId, poolId))
    .groupBy(poolRoles.id)
    .orderBy(poolRoles.name);
  return rows.map((row) => ({ ...row.role, userCount: row.userCount }));
}

export async function findRole(
  db: Queryable,
  poolId: string,
  name: string,
): Promise<(PoolRole & { userCount: number }) | undefined> {
  const [row] = await db
    .select({ role: poolRoles, userCount: count(poolUserRoles.userId) })
    .from(poolRoles)
    .leftJoin(poolUserRoles, eq(poolUserRoles.roleId, poolRoles.id))
    .where(and(eq(poolRoles.poolId, poolId), eq(poolRoles.name, name)))
    .groupBy(poolRoles.id);
  return row ? { ...row.role, userCount: row.userCount } : undefined;
}

export async function countRoles(
  db: Queryable,
  poolId: string,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(poolRoles)
    .where(eq(poolRoles.poolId, poolId));
  return row?.n ?? 0;
}

export async function insertRole(
  db: Queryable,
  values: typeof poolRoles.$inferInsert,
): Promise<PoolRole | undefined> {
  const [saved] = await db
    .insert(poolRoles)
    .values(values)
    .onConflictDoNothing()
    .returning();
  return saved;
}

export async function updateRole(
  db: Queryable,
  poolId: string,
  name: string,
  changes: { description?: string; permissions?: string[] },
): Promise<PoolRole | undefined> {
  const [saved] = await db
    .update(poolRoles)
    .set({ ...changes, updatedAt: sql`now()` })
    .where(and(eq(poolRoles.poolId, poolId), eq(poolRoles.name, name)))
    .returning();
  return saved;
}

export async function deleteRole(
  db: Queryable,
  poolId: string,
  name: string,
): Promise<PoolRole | undefined> {
  const [deleted] = await db
    .delete(poolRoles)
    .where(and(eq(poolRoles.poolId, poolId), eq(poolRoles.name, name)))
    .returning();
  return deleted;
}

export async function userRoles(
  db: Queryable,
  userId: string,
): Promise<Pick<PoolRole, "name" | "permissions">[]> {
  return db
    .select({ name: poolRoles.name, permissions: poolRoles.permissions })
    .from(poolUserRoles)
    .innerJoin(poolRoles, eq(poolRoles.id, poolUserRoles.roleId))
    .where(eq(poolUserRoles.userId, userId))
    .orderBy(poolRoles.name);
}

export async function rolesOfUsers(
  db: Queryable,
  userIds: string[],
): Promise<Map<string, string[]>> {
  const roles = new Map<string, string[]>();
  if (userIds.length === 0) return roles;
  const rows = await db
    .select({ userId: poolUserRoles.userId, name: poolRoles.name })
    .from(poolUserRoles)
    .innerJoin(poolRoles, eq(poolRoles.id, poolUserRoles.roleId))
    .where(inArray(poolUserRoles.userId, userIds))
    .orderBy(poolRoles.name);
  for (const row of rows) {
    roles.set(row.userId, [...(roles.get(row.userId) ?? []), row.name]);
  }
  return roles;
}

export async function countUserRoles(
  db: Queryable,
  userId: string,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(poolUserRoles)
    .where(eq(poolUserRoles.userId, userId));
  return row?.n ?? 0;
}

export async function addUserRole(
  db: Queryable,
  userId: string,
  roleId: string,
): Promise<boolean> {
  const rows = await db
    .insert(poolUserRoles)
    .values({ userId, roleId })
    .onConflictDoNothing()
    .returning({ userId: poolUserRoles.userId });
  return rows.length === 1;
}

export async function removeUserRole(
  db: Queryable,
  userId: string,
  roleId: string,
): Promise<boolean> {
  const rows = await db
    .delete(poolUserRoles)
    .where(
      and(eq(poolUserRoles.userId, userId), eq(poolUserRoles.roleId, roleId)),
    )
    .returning({ userId: poolUserRoles.userId });
  return rows.length === 1;
}

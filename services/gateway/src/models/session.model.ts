import { and, desc, eq, gt, isNull, ne, or, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { sessions, users, type Session, type User } from "../db/schema.js";

export async function insertSession(
  db: Database,
  values: {
    userId: string;
    tokenHash: string;
    accessExpiresAt: Date;
    refreshHash: string;
    expiresAt: Date;
    ip?: string;
    userAgent?: string;
  },
): Promise<Session> {
  const [session] = await db.insert(sessions).values(values).returning();
  if (!session) throw new Error("the session was not saved");
  return session;
}

export function findSession(
  db: Database,
  tokenHash: string,
): Promise<{ session: Session; user: User } | undefined> {
  return db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)))
    .then(([row]) => row);
}

export function findSessionByRefresh(
  db: Database,
  refreshHash: string,
): Promise<{ session: Session; user: User } | undefined> {
  return db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        or(
          eq(sessions.refreshHash, refreshHash),
          eq(sessions.previousRefreshHash, refreshHash),
        ),
        isNull(sessions.revokedAt),
      ),
    )
    .then(([row]) => row);
}

export async function rotateSession(
  db: Database,
  id: string,
  oldRefreshHash: string,
  values: {
    tokenHash: string;
    accessExpiresAt: Date;
    refreshHash: string;
    previousRefreshUntil: Date;
  },
): Promise<boolean> {
  const rows = await db
    .update(sessions)
    .set({
      ...values,
      previousRefreshHash: oldRefreshHash,
      lastUsedAt: sql`now()`,
    })
    .where(
      and(
        eq(sessions.id, id),
        eq(sessions.refreshHash, oldRefreshHash),
        isNull(sessions.revokedAt),
      ),
    )
    .returning({ id: sessions.id });
  return rows.length === 1;
}

export async function touchSession(db: Database, id: string): Promise<void> {
  await db
    .update(sessions)
    .set({ lastUsedAt: sql`now()` })
    .where(eq(sessions.id, id));
}

export async function revokeSession(db: Database, id: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)));
}

export async function revokeUserSessions(
  db: Database,
  userId: string,
  exceptId?: string,
): Promise<void> {
  const conditions = [eq(sessions.userId, userId), isNull(sessions.revokedAt)];
  if (exceptId) conditions.push(ne(sessions.id, exceptId));
  await db
    .update(sessions)
    .set({ revokedAt: sql`now()` })
    .where(and(...conditions));
}

export function listUserSessions(
  db: Database,
  userId: string,
  idleTimeoutMs: number,
): Promise<Session[]> {
  const now = new Date();
  return db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
        gt(sessions.lastUsedAt, new Date(now.getTime() - idleTimeoutMs)),
      ),
    )
    .orderBy(desc(sessions.lastUsedAt));
}

export async function revokeUserSession(
  db: Database,
  userId: string,
  id: string,
): Promise<boolean> {
  const rows = await db
    .update(sessions)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        eq(sessions.id, id),
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
      ),
    )
    .returning({ id: sessions.id });
  return rows.length === 1;
}

import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { users, type User } from "../db/schema.js";

export function findUserByEmail(
  db: Database,
  email: string,
): Promise<User | undefined> {
  return db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .then(([user]) => user);
}

export function findUserById(
  db: Database,
  id: string,
): Promise<User | undefined> {
  return db
    .select()
    .from(users)
    .where(eq(users.id, id))
    .then(([user]) => user);
}

export async function insertUser(
  db: Database,
  values: { email: string; passwordHash: string },
): Promise<User | undefined> {
  const [user] = await db
    .insert(users)
    .values(values)
    .onConflictDoNothing({ target: users.email })
    .returning();
  return user;
}

export async function updatePasswordHash(
  db: Database,
  userId: string,
  passwordHash: string,
): Promise<void> {
  await db
    .update(users)
    .set({ passwordHash, updatedAt: sql`now()` })
    .where(eq(users.id, userId));
}

export async function updateDisplayName(
  db: Database,
  userId: string,
  displayName: string | null,
): Promise<void> {
  await db
    .update(users)
    .set({ displayName, updatedAt: sql`now()` })
    .where(eq(users.id, userId));
}

export async function deleteUser(db: Database, userId: string): Promise<void> {
  await db.delete(users).where(eq(users.id, userId));
}

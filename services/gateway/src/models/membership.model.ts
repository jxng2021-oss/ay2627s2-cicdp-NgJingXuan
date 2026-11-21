import { and, asc, count, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { memberships, tenants } from "../db/schema.js";

export type Role = "owner" | "member";

export interface WorkspaceMembership {
  tenantId: string;
  name: string;
  status: "active" | "suspended" | "deleting" | "deleted";
  role: Role;
}

export async function insertMembership(
  db: Database,
  values: { userId: string; tenantId: string; role: Role },
): Promise<boolean> {
  const inserted = await db
    .insert(memberships)
    .values(values)
    .onConflictDoNothing()
    .returning({ userId: memberships.userId });
  return inserted.length > 0;
}

export function findMembership(
  db: Database,
  userId: string,
  tenantId: string,
): Promise<WorkspaceMembership | undefined> {
  return db
    .select({
      tenantId: tenants.id,
      name: tenants.name,
      status: tenants.status,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
    .where(
      and(eq(memberships.userId, userId), eq(memberships.tenantId, tenantId)),
    )
    .then(([row]) => row);
}

export function listMemberships(
  db: Database,
  userId: string,
): Promise<WorkspaceMembership[]> {
  return db
    .select({
      tenantId: tenants.id,
      name: tenants.name,
      status: tenants.status,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
    .where(eq(memberships.userId, userId))
    .orderBy(asc(memberships.createdAt));
}

export function countOwners(db: Database, tenantId: string): Promise<number> {
  return db
    .select({ owners: count() })
    .from(memberships)
    .where(
      and(eq(memberships.tenantId, tenantId), eq(memberships.role, "owner")),
    )
    .then(([row]) => row?.owners ?? 0);
}

export async function deleteMembership(
  db: Database,
  userId: string,
  tenantId: string,
): Promise<void> {
  await db
    .delete(memberships)
    .where(
      and(eq(memberships.userId, userId), eq(memberships.tenantId, tenantId)),
    );
}

export async function soleOwnerOf(
  db: Database,
  userId: string,
): Promise<WorkspaceMembership[]> {
  const sole: WorkspaceMembership[] = [];
  for (const workspace of await listMemberships(db, userId)) {
    if (
      workspace.role === "owner" &&
      (await countOwners(db, workspace.tenantId)) === 1
    ) {
      sole.push(workspace);
    }
  }
  return sole;
}

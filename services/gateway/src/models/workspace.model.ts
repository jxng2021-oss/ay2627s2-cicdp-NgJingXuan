import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/client.js";
import {
  apiKeys,
  memberships,
  proxyConnections,
  tenants,
} from "../db/schema.js";

export async function startWorkspaceDeletion(
  db: Database,
  tenantId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(tenants)
      .set({ status: "deleting", updatedAt: new Date() })
      .where(
        and(
          eq(tenants.id, tenantId),
          inArray(tenants.status, ["active", "suspended", "deleting"]),
        ),
      );
    await tx
      .update(apiKeys)
      .set({ status: "revoked", revokedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.status, "active")));
  });
}

export async function finishWorkspaceDeletion(
  db: Database,
  tenantId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(proxyConnections)
      .where(eq(proxyConnections.tenantId, tenantId));
    await tx.delete(memberships).where(eq(memberships.tenantId, tenantId));
    await tx
      .update(tenants)
      .set({ status: "deleted", updatedAt: new Date() })
      .where(eq(tenants.id, tenantId));
  });
}

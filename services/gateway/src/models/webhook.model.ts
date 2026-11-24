import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import {
  webhookEndpoints,
  webhookEvents,
  type WebhookEndpoint,
  type WebhookEvent,
} from "../db/schema.js";
import type { CleanEventData } from "../services/stripe-webhook.service.js";

export function findEndpoint(
  db: Database,
  id: string,
): Promise<WebhookEndpoint | undefined> {
  return db
    .select()
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.id, id))
    .then(([endpoint]) => endpoint);
}

export function findTenantEndpoint(
  db: Database,
  tenantId: string,
  id: string,
): Promise<WebhookEndpoint | undefined> {
  return db
    .select()
    .from(webhookEndpoints)
    .where(
      and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.tenantId, tenantId)),
    )
    .then(([endpoint]) => endpoint);
}

export function listEndpoints(
  db: Database,
  tenantId: string,
): Promise<WebhookEndpoint[]> {
  return db
    .select()
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.tenantId, tenantId))
    .orderBy(asc(webhookEndpoints.name));
}

export function countEndpoints(db: Database, tenantId: string) {
  return db
    .select({ count: sql<number>`count(*)::int` })
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.tenantId, tenantId))
    .then(([row]) => row?.count ?? 0);
}

export async function insertEndpoint(
  db: Database,
  values: {
    tenantId: string;
    name: string;
    provider: string;
    signingSecretName: string;
    forwardUrl: string | null;
  },
): Promise<WebhookEndpoint | undefined> {
  const [endpoint] = await db
    .insert(webhookEndpoints)
    .values(values)
    .onConflictDoNothing()
    .returning();
  return endpoint;
}

export async function updateEndpoint(
  db: Database,
  tenantId: string,
  id: string,
  values: { signingSecretName?: string; forwardUrl?: string | null },
): Promise<WebhookEndpoint | undefined> {
  const [endpoint] = await db
    .update(webhookEndpoints)
    .set({ ...values, updatedAt: sql`now()` })
    .where(
      and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.tenantId, tenantId)),
    )
    .returning();
  return endpoint;
}

export async function deleteEndpoint(
  db: Database,
  tenantId: string,
  id: string,
): Promise<boolean> {
  const deleted = await db
    .delete(webhookEndpoints)
    .where(
      and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.tenantId, tenantId)),
    )
    .returning({ id: webhookEndpoints.id });
  return deleted.length > 0;
}

export async function insertEvent(
  db: Database,
  values: {
    endpointId: string;
    tenantId: string;
    data: CleanEventData;
    deliveryStatus: "pending" | "pull";
    firstAttemptAt: Date | null;
  },
): Promise<WebhookEvent | undefined> {
  const { firstAttemptAt, ...fields } = values;
  const [event] = await db
    .insert(webhookEvents)
    .values({
      ...fields,
      providerEventId: values.data.providerEventId,
      nextAttemptAt: firstAttemptAt,
    })
    .onConflictDoNothing()
    .returning();
  return event;
}

export function claimDueEvents(
  db: Database,
  leaseMs: number,
  limit = 20,
): Promise<WebhookEvent[]> {
  return db.transaction(async (tx) => {
    const due = await tx
      .select({ id: webhookEvents.id })
      .from(webhookEvents)
      .where(
        and(
          eq(webhookEvents.deliveryStatus, "pending"),
          sql`${webhookEvents.nextAttemptAt} <= now()`,
        ),
      )
      .orderBy(asc(webhookEvents.nextAttemptAt))
      .limit(limit)
      .for("update", { skipLocked: true });
    if (due.length === 0) return [];
    return tx
      .update(webhookEvents)
      .set({
        nextAttemptAt: sql`now() + ${`${leaseMs} milliseconds`}::interval`,
      })
      .where(
        sql`${webhookEvents.id} in (${sql.join(
          due.map((row) => sql`${row.id}`),
          sql`, `,
        )})`,
      )
      .returning();
  });
}

export async function recordDelivery(
  db: Database,
  id: string,
  outcome:
    | { delivered: true }
    | { delivered: false; error: string; retryAt: Date | null },
): Promise<void> {
  await db
    .update(webhookEvents)
    .set(
      outcome.delivered
        ? {
            deliveryStatus: "delivered",
            deliveredAt: sql`now()`,
            attempts: sql`${webhookEvents.attempts} + 1`,
            nextAttemptAt: null,
            lastError: null,
          }
        : {
            deliveryStatus: outcome.retryAt ? "pending" : "failed",
            attempts: sql`${webhookEvents.attempts} + 1`,
            nextAttemptAt: outcome.retryAt,
            lastError: outcome.error.slice(0, 200),
          },
    )
    .where(eq(webhookEvents.id, id));
}

export async function requeueEvent(
  db: Database,
  tenantId: string,
  id: string,
): Promise<boolean> {
  const updated = await db
    .update(webhookEvents)
    .set({
      deliveryStatus: "pending",
      nextAttemptAt: sql`now()`,
      attempts: 0,
      lastError: null,
    })
    .where(and(eq(webhookEvents.id, id), eq(webhookEvents.tenantId, tenantId)))
    .returning({ id: webhookEvents.id });
  return updated.length > 0;
}

export function listEndpointEvents(
  db: Database,
  tenantId: string,
  endpointId: string,
  limit = 50,
): Promise<WebhookEvent[]> {
  return db
    .select()
    .from(webhookEvents)
    .where(
      and(
        eq(webhookEvents.tenantId, tenantId),
        eq(webhookEvents.endpointId, endpointId),
      ),
    )
    .orderBy(desc(webhookEvents.seq))
    .limit(limit);
}

export function listEventsAfter(
  db: Database,
  tenantId: string,
  after: number,
  limit: number,
  endpointId?: string,
): Promise<WebhookEvent[]> {
  return db
    .select()
    .from(webhookEvents)
    .where(
      and(
        eq(webhookEvents.tenantId, tenantId),
        gt(webhookEvents.seq, after),
        endpointId ? eq(webhookEvents.endpointId, endpointId) : undefined,
      ),
    )
    .orderBy(asc(webhookEvents.seq))
    .limit(limit);
}

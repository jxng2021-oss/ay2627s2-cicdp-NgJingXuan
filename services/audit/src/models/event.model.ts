import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  lt,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  ChainVerifier,
  computeHash,
  GENESIS_HASH,
  type VerifyResult,
} from "../chain.js";
import type { Database } from "../db/client.js";
import { auditEvents, type AuditRow } from "../db/schema.js";

export type NewEvent = Omit<
  AuditRow,
  "id" | "seq" | "occurredAt" | "prevHash" | "hash"
>;

export async function appendEvent(
  db: Database,
  hmacKey: string,
  event: NewEvent,
): Promise<AuditRow> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${event.chain}, 0))`,
    );
    const [last] = await tx
      .select({ seq: auditEvents.seq, hash: auditEvents.hash })
      .from(auditEvents)
      .where(eq(auditEvents.chain, event.chain))
      .orderBy(desc(auditEvents.seq))
      .limit(1);
    const fields = {
      ...event,
      id: randomUUID(),
      seq: (last?.seq ?? 0) + 1,
      occurredAt: new Date(),
      prevHash: last?.hash ?? GENESIS_HASH,
    };
    const row: AuditRow = { ...fields, hash: computeHash(hmacKey, fields) };
    await tx.insert(auditEvents).values(row);
    return row;
  });
}

export interface EventFilters {
  tenantId?: string;
  from?: Date;
  to?: Date;
  action?: string;
  outcome?: string;
  resourceType?: string;
  resourceId?: string;
  beforeSeq?: number;
}

export function listEvents(
  db: Database,
  chain: string,
  filters: EventFilters,
  limit: number,
): Promise<AuditRow[]> {
  const conditions: SQL[] = [eq(auditEvents.chain, chain)];
  if (filters.tenantId)
    conditions.push(eq(auditEvents.tenantId, filters.tenantId));
  if (filters.from) conditions.push(gte(auditEvents.occurredAt, filters.from));
  if (filters.to) conditions.push(lt(auditEvents.occurredAt, filters.to));
  if (filters.action) conditions.push(eq(auditEvents.action, filters.action));
  if (filters.outcome)
    conditions.push(eq(auditEvents.outcome, filters.outcome));
  if (filters.resourceType) {
    conditions.push(eq(auditEvents.resourceType, filters.resourceType));
  }
  if (filters.resourceId) {
    conditions.push(eq(auditEvents.resourceId, filters.resourceId));
  }
  if (filters.beforeSeq !== undefined) {
    conditions.push(lt(auditEvents.seq, filters.beforeSeq));
  }
  return db
    .select()
    .from(auditEvents)
    .where(and(...conditions))
    .orderBy(desc(auditEvents.seq))
    .limit(limit);
}

export async function listChains(db: Database): Promise<string[]> {
  const rows = await db
    .selectDistinct({ chain: auditEvents.chain })
    .from(auditEvents)
    .orderBy(asc(auditEvents.chain));
  return rows.map((row) => row.chain);
}

export async function verifyChain(
  db: Database,
  hmacKey: string,
  chain: string,
): Promise<VerifyResult> {
  const verifier = new ChainVerifier(hmacKey, chain);
  let afterSeq = 0;
  for (;;) {
    const page = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.chain, chain), gt(auditEvents.seq, afterSeq)))
      .orderBy(asc(auditEvents.seq))
      .limit(1000);
    if (page.length === 0 || !verifier.check(page)) break;
    afterSeq = page.at(-1)!.seq;
  }
  return verifier.result();
}

export interface DailyCount {
  day: string;
  action: string;
  outcome: string;
  count: number;
}

export interface ConnectionCount {
  resourceId: string;
  action: string;
  outcome: string;
  count: number;
}

export async function summarizeEvents(
  db: Database,
  chain: string,
  from: Date,
  to: Date,
): Promise<{ daily: DailyCount[]; connections: ConnectionCount[] }> {
  const inRange = and(
    eq(auditEvents.chain, chain),
    gte(auditEvents.occurredAt, from),
    lt(auditEvents.occurredAt, to),
  );
  const day = sql<string>`to_char(${auditEvents.occurredAt} at time zone 'UTC', 'YYYY-MM-DD')`;
  const count = sql<number>`count(*)::int`;

  const daily = await db
    .select({
      day,
      action: auditEvents.action,
      outcome: auditEvents.outcome,
      count,
    })
    .from(auditEvents)
    .where(inRange)
    .groupBy(day, auditEvents.action, auditEvents.outcome)
    .orderBy(day);

  const connections = await db
    .select({
      resourceId: sql<string>`${auditEvents.resourceId}`,
      action: auditEvents.action,
      outcome: auditEvents.outcome,
      count,
    })
    .from(auditEvents)
    .where(
      and(
        inRange,
        eq(auditEvents.resourceType, "proxy_connection"),
        inArray(auditEvents.action, [
          "proxy_connection.used",
          "proxy_connection.denied",
        ]),
        isNotNull(auditEvents.resourceId),
      ),
    )
    .groupBy(auditEvents.resourceId, auditEvents.action, auditEvents.outcome);

  return { daily, connections };
}

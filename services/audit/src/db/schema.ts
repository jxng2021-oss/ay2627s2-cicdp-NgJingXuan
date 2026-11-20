import {
  bigint,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey(),
    chain: text("chain").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    occurredAt: timestamp("occurred_at", {
      withTimezone: true,
      precision: 3,
    }).notNull(),
    tenantId: uuid("tenant_id"),
    service: text("service").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    outcome: text("outcome").notNull(),
    requestId: uuid("request_id"),
    sourceIp: text("source_ip"),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
  },
  (table) => [
    unique("audit_events_chain_seq").on(table.chain, table.seq),
    index("audit_events_chain_time").on(table.chain, table.occurredAt),
    index("audit_events_request").on(table.requestId),
  ],
);

export type AuditRow = typeof auditEvents.$inferSelect;

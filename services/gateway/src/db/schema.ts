import {
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const tenantStatus = pgEnum("tenant_status", ["active", "suspended"]);
export const apiKeyStatus = pgEnum("api_key_status", ["active", "revoked"]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
};

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  status: tenantStatus("status").notNull().default("active"),
  ...timestamps,
});

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    lookupPrefix: text("lookup_prefix").notNull().unique(),
    secretHash: text("secret_hash").notNull(),
    status: apiKeyStatus("status").notNull().default("active"),
    ...timestamps,
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (table) => [index("api_keys_tenant_id_idx").on(table.tenantId)],
);

export type Tenant = typeof tenants.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;

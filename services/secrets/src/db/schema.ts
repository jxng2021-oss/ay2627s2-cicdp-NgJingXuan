import { sql } from "drizzle-orm";
import {
  check,
  customType,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; driverData: Uint8Array }>({
  dataType: () => "bytea",
  fromDriver: (value) => Buffer.from(value),
});

const encrypted = {
  formatVersion: smallint("format_version").notNull(),
  nonce: bytea("nonce").notNull(),
  ciphertext: bytea("ciphertext").notNull(),
  authTag: bytea("auth_tag").notNull(),
};

const createdAt = timestamp("created_at", { withTimezone: true })
  .notNull()
  .defaultNow();

export const tenantKeyStatus = pgEnum("tenant_key_status", [
  "active",
  "retired",
]);

export const tenantKeys = pgTable(
  "tenant_keys",
  {
    tenantId: uuid("tenant_id").notNull(),
    keyVersion: integer("key_version").notNull(),
    status: tenantKeyStatus("status").notNull().default("active"),
    masterKeyVersion: integer("master_key_version").notNull(),
    ...encrypted,
    createdAt,
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.keyVersion] }),
    uniqueIndex("tenant_keys_one_active_per_tenant")
      .on(table.tenantId)
      .where(sql`status = 'active'`),
  ],
);

export const secrets = pgTable(
  "secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    name: text("name").notNull(),
    latestVersion: integer("latest_version").notNull(),
    createdAt,
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique("secrets_tenant_name").on(table.tenantId, table.name)],
);

export const secretVersions = pgTable(
  "secret_versions",
  {
    secretId: uuid("secret_id")
      .notNull()
      .references(() => secrets.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    tenantKeyVersion: integer("tenant_key_version").notNull(),
    ...encrypted,
    createdAt,
  },
  (table) => [primaryKey({ columns: [table.secretId, table.version] })],
);

export const sealConfig = pgTable(
  "seal_config",
  {
    id: smallint("id").primaryKey().default(1),
    sealId: uuid("seal_id").notNull(),
    shareCount: smallint("share_count").notNull(),
    threshold: smallint("threshold").notNull(),
    masterKeyVersion: integer("master_key_version").notNull(),
    ...encrypted,
    createdAt,
  },
  (table) => [check("seal_config_single_row", sql`${table.id} = 1`)],
);

export const shreddedTenants = pgTable("shredded_tenants", {
  tenantId: uuid("tenant_id").primaryKey(),
  shreddedAt: timestamp("shredded_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type SealConfigRow = typeof sealConfig.$inferSelect;
export type TenantKeyRow = typeof tenantKeys.$inferSelect;
export type SecretRow = typeof secrets.$inferSelect;
export type SecretVersionRow = typeof secretVersions.$inferSelect;

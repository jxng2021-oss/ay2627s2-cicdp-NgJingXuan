import {
  index,
  jsonb,
  pgEnum,
  primaryKey,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { ConnectionPolicy } from "../services/policy.service.js";

export const tenantStatus = pgEnum("tenant_status", [
  "active",
  "suspended",
  "deleting",
  "deleted",
]);
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

export const proxyConnections = pgTable(
  "proxy_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    baseUrl: text("base_url").notNull(),
    secretName: text("secret_name").notNull(),
    headerName: text("header_name").notNull(),
    headerPrefix: text("header_prefix").notNull().default(""),
    policy: jsonb("policy").$type<ConnectionPolicy>(),
    ...timestamps,
  },
  (table) => [
    unique("proxy_connections_tenant_name").on(table.tenantId, table.name),
  ],
);

export const userStatus = pgEnum("user_status", ["active", "disabled"]);
export const membershipRole = pgEnum("membership_role", ["owner", "member"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  displayName: text("display_name"),
  status: userStatus("status").notNull().default("active"),
  ...timestamps,
});

export const memberships = pgTable(
  "memberships",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    role: membershipRole("role").notNull(),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.tenantId] }),
    index("memberships_tenant_id_idx").on(table.tenantId),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    accessExpiresAt: timestamp("access_expires_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    refreshHash: text("refresh_hash").unique(),
    previousRefreshHash: text("previous_refresh_hash"),
    previousRefreshUntil: timestamp("previous_refresh_until", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (table) => [
    index("sessions_user_id_idx").on(table.userId),
    index("sessions_previous_refresh_idx").on(table.previousRefreshHash),
  ],
);

export const oauthProvider = pgEnum("oauth_provider", ["google", "github"]);

export const oauthIdentities = pgTable(
  "oauth_identities",
  {
    provider: oauthProvider("provider").notNull(),
    subject: text("subject").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.subject] }),
    index("oauth_identities_user_id_idx").on(table.userId),
  ],
);

export type Tenant = typeof tenants.$inferSelect;
export type User = typeof users.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type ProxyConnection = typeof proxyConnections.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;

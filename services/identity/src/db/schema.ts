import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const pools = pgTable(
  "pools",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    name: text("name").notNull(),
    accessTokenTtlSeconds: integer("access_token_ttl_seconds").notNull(),
    refreshTokenTtlSeconds: integer("refresh_token_ttl_seconds").notNull(),
    minPasswordLength: integer("min_password_length").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("pools_tenant_name").on(table.tenantId, table.name),
    index("pools_tenant_idx").on(table.tenantId),
  ],
);

export const signingKeys = pgTable("signing_keys", {
  id: uuid("id").primaryKey(),
  poolId: uuid("pool_id")
    .notNull()
    .references(() => pools.id, { onDelete: "cascade" }),
  publicJwk: jsonb("public_jwk").$type<Record<string, string>>().notNull(),
  formatVersion: integer("format_version").notNull(),
  nonce: bytea("nonce").notNull(),
  ciphertext: bytea("ciphertext").notNull(),
  authTag: bytea("auth_tag").notNull(),
  wrappedDataKey: bytea("wrapped_data_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const poolUsers = pgTable(
  "pool_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    poolId: uuid("pool_id")
      .notNull()
      .references(() => pools.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    status: text("status").$type<"active" | "disabled">().notNull(),
    attributes: jsonb("attributes")
      .$type<Record<string, string | number | boolean>>()
      .notNull(),
    failedLogins: integer("failed_logins").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique("pool_users_pool_email").on(table.poolId, table.email)],
);

export const poolSessions = pgTable(
  "pool_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    poolId: uuid("pool_id")
      .notNull()
      .references(() => pools.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => poolUsers.id, { onDelete: "cascade" }),
    refreshHash: text("refresh_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revoked: boolean("revoked").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("pool_sessions_user_idx").on(table.userId)],
);

export const usedRefreshTokens = pgTable("used_refresh_tokens", {
  hash: text("hash").primaryKey(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => poolSessions.id, { onDelete: "cascade" }),
});

export const poolRoles = pgTable(
  "pool_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    poolId: uuid("pool_id")
      .notNull()
      .references(() => pools.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    permissions: jsonb("permissions").$type<string[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique("pool_roles_pool_name").on(table.poolId, table.name)],
);

export const poolUserRoles = pgTable(
  "pool_user_roles",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => poolUsers.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => poolRoles.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.roleId] }),
    index("pool_user_roles_role_idx").on(table.roleId),
  ],
);

export type Pool = typeof pools.$inferSelect;
export type PoolRole = typeof poolRoles.$inferSelect;
export type SigningKey = typeof signingKeys.$inferSelect;
export type PoolUser = typeof poolUsers.$inferSelect;
export type PoolSession = typeof poolSessions.$inferSelect;

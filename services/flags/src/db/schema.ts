import {
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const ENVIRONMENTS = ["development", "staging", "production"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export type FlagValue = boolean | string;

export interface Condition {
  attribute: string;
  operator:
    | "equals"
    | "not_equals"
    | "in"
    | "not_in"
    | "contains"
    | "starts_with"
    | "greater_than"
    | "less_than";
  values: string[];
}

export interface Rule {
  conditions: Condition[];
  value: FlagValue;
  percentage?: number;
}

export interface EnvironmentSettings {
  enabled: boolean;
  rules: Rule[];
  rollout?: { percentage: number; value: FlagValue };
  defaultValue: FlagValue;
}

export const flags = pgTable(
  "flags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    key: text("key").notNull(),
    description: text("description").notNull(),
    kind: text("kind").$type<"boolean" | "string">().notNull(),
    offValue: jsonb("off_value").$type<FlagValue>().notNull(),
    environments: jsonb("environments")
      .$type<Record<Environment, EnvironmentSettings>>()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique("flags_tenant_key").on(table.tenantId, table.key)],
);

export type Flag = typeof flags.$inferSelect;

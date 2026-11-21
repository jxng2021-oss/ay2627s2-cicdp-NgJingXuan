import { createHash } from "node:crypto";
import type { Condition, Environment, Flag, FlagValue } from "./db/schema.js";

export interface Context {
  key: string;
  attributes?: Record<string, string | number | boolean>;
}

export interface Result {
  value: FlagValue;
  reason: "off" | "rule" | "rollout" | "default";
  ruleIndex?: number;
}

export function bucket(flagKey: string, userKey: string): number {
  const digest = createHash("sha256").update(`${flagKey}:${userKey}`).digest();
  return (digest.readUInt32BE(0) % 10_000) / 100;
}

function attribute(context: Context, name: string): string | undefined {
  if (name === "key") return context.key;
  const value = context.attributes?.[name];
  return value === undefined ? undefined : String(value);
}

export function matches(condition: Condition, context: Context): boolean {
  const actual = attribute(context, condition.attribute);
  if (actual === undefined) {
    return (
      condition.operator === "not_equals" || condition.operator === "not_in"
    );
  }
  const [first = ""] = condition.values;
  switch (condition.operator) {
    case "equals":
      return actual === first;
    case "not_equals":
      return actual !== first;
    case "in":
      return condition.values.includes(actual);
    case "not_in":
      return !condition.values.includes(actual);
    case "contains":
      return actual.includes(first);
    case "starts_with":
      return actual.startsWith(first);
    case "greater_than":
    case "less_than": {
      const a = Number(actual);
      const b = Number(first);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      return condition.operator === "greater_than" ? a > b : a < b;
    }
  }
}

export function evaluate(
  flag: Pick<Flag, "key" | "offValue" | "environments">,
  environment: Environment,
  context: Context,
): Result {
  const settings = flag.environments[environment];
  if (!settings.enabled) return { value: flag.offValue, reason: "off" };
  const place = bucket(flag.key, context.key);
  for (const [index, rule] of settings.rules.entries()) {
    if (!rule.conditions.every((condition) => matches(condition, context))) {
      continue;
    }
    if (rule.percentage === undefined || place < rule.percentage) {
      return { value: rule.value, reason: "rule", ruleIndex: index };
    }
  }
  if (settings.rollout && place < settings.rollout.percentage) {
    return { value: settings.rollout.value, reason: "rollout" };
  }
  return { value: settings.defaultValue, reason: "default" };
}

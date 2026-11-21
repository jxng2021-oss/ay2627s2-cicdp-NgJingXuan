import { describe, expect, it } from "vitest";
import type {
  EnvironmentSettings,
  Flag,
} from "../../services/flags/src/db/schema.js";
import {
  bucket,
  evaluate,
  matches,
  type Context,
} from "../../services/flags/src/evaluate.js";

function flagWith(production: Partial<EnvironmentSettings>) {
  const off: EnvironmentSettings = {
    enabled: false,
    rules: [],
    defaultValue: false,
  };
  return {
    key: "new-checkout",
    offValue: false,
    environments: {
      development: off,
      staging: off,
      production: { ...off, enabled: true, ...production },
    },
  } satisfies Pick<Flag, "key" | "offValue" | "environments">;
}

const ada: Context = {
  key: "user-ada",
  attributes: { country: "SG", plan: "pro", seats: 12 },
};

describe("evaluate", () => {
  it("serves the off value while the flag is off", () => {
    expect(evaluate(flagWith({}), "staging", ada)).toEqual({
      value: false,
      reason: "off",
    });
  });

  it("serves the first rule whose conditions all match", () => {
    const flag = flagWith({
      rules: [
        {
          conditions: [
            { attribute: "country", operator: "equals", values: ["MY"] },
          ],
          value: true,
        },
        {
          conditions: [
            { attribute: "country", operator: "in", values: ["SG", "MY"] },
            { attribute: "plan", operator: "equals", values: ["pro"] },
          ],
          value: true,
        },
      ],
    });
    expect(evaluate(flag, "production", ada)).toEqual({
      value: true,
      reason: "rule",
      ruleIndex: 1,
    });
    expect(
      evaluate(flag, "production", {
        key: "bob",
        attributes: { country: "SG", plan: "free" },
      }),
    ).toEqual({ value: false, reason: "default" });
  });

  it("each operator, and missing attributes only match 'not' conditions", () => {
    const c = (
      operator: Parameters<typeof matches>[0]["operator"],
      attribute: string,
      values: string[],
    ) => matches({ attribute, operator, values }, ada);
    expect(c("equals", "country", ["SG"])).toBe(true);
    expect(c("not_equals", "country", ["SG"])).toBe(false);
    expect(c("in", "plan", ["team", "pro"])).toBe(true);
    expect(c("not_in", "plan", ["team", "pro"])).toBe(false);
    expect(c("contains", "key", ["ada"])).toBe(true);
    expect(c("starts_with", "key", ["user-"])).toBe(true);
    expect(c("greater_than", "seats", ["10"])).toBe(true);
    expect(c("less_than", "seats", ["10"])).toBe(false);
    expect(c("greater_than", "plan", ["10"])).toBe(false);
    expect(c("equals", "missing", ["x"])).toBe(false);
    expect(c("not_equals", "missing", ["x"])).toBe(true);
  });

  it("percentages: stable per user, and about the right share", () => {
    const flag = flagWith({ rollout: { percentage: 25, value: true } });
    const users = Array.from({ length: 4000 }, (_, i) => ({
      key: `user-${i}`,
    }));
    const on = users.filter(
      (user) => evaluate(flag, "production", user).value === true,
    );

    expect(on.length / users.length).toBeGreaterThan(0.22);
    expect(on.length / users.length).toBeLessThan(0.28);
    const raised = flagWith({ rollout: { percentage: 50, value: true } });
    for (const user of on) {
      expect(evaluate(flag, "production", user)).toEqual({
        value: true,
        reason: "rollout",
      });
      expect(evaluate(raised, "production", user).value).toBe(true);
    }
    expect(bucket("new-checkout", "user-1")).toBe(
      bucket("new-checkout", "user-1"),
    );
    expect(bucket("other-flag", "user-1")).not.toBe(
      bucket("new-checkout", "user-1"),
    );
  });

  it("a rule with a percentage lets the rest fall through", () => {
    const flag = flagWith({
      rules: [
        {
          conditions: [
            { attribute: "country", operator: "equals", values: ["SG"] },
          ],
          value: true,
          percentage: 0,
        },
      ],
      defaultValue: false,
    });
    expect(evaluate(flag, "production", ada)).toEqual({
      value: false,
      reason: "default",
    });
  });
});

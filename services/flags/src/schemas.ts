import { Type, type Static } from "typebox";

export const FLAG_KEY = "^[a-z0-9][a-z0-9._-]{0,63}$";
const ATTRIBUTE = "^[A-Za-z][A-Za-z0-9_]{0,39}$";

export const Value = Type.Union([
  Type.Boolean(),
  Type.String({ maxLength: 200 }),
]);

export const Condition = Type.Object(
  {
    attribute: Type.String({ pattern: ATTRIBUTE }),
    operator: Type.Enum([
      "equals",
      "not_equals",
      "in",
      "not_in",
      "contains",
      "starts_with",
      "greater_than",
      "less_than",
    ]),
    values: Type.Array(Type.String({ maxLength: 200 }), {
      minItems: 1,
      maxItems: 50,
    }),
  },
  { additionalProperties: false },
);

const Percentage = Type.Number({ minimum: 0, maximum: 100 });

export const Rule = Type.Object(
  {
    conditions: Type.Array(Condition, { minItems: 1, maxItems: 10 }),
    value: Value,
    percentage: Type.Optional(Percentage),
  },
  { additionalProperties: false },
);

export const EnvironmentSettings = Type.Object(
  {
    enabled: Type.Boolean(),
    rules: Type.Array(Rule, { maxItems: 20 }),
    rollout: Type.Optional(
      Type.Object(
        { percentage: Percentage, value: Value },
        { additionalProperties: false },
      ),
    ),
    defaultValue: Value,
  },
  { additionalProperties: false },
);

export const Environment = Type.Enum(["development", "staging", "production"]);

export const FlagParams = Type.Object({
  key: Type.String({ pattern: FLAG_KEY }),
});
export const EnvironmentParams = Type.Object({
  key: Type.String({ pattern: FLAG_KEY }),
  environment: Environment,
});

export const NewFlagBody = Type.Object(
  {
    key: Type.String({ pattern: FLAG_KEY }),
    description: Type.Optional(Type.String({ maxLength: 500 })),
    kind: Type.Enum(["boolean", "string"]),
    offValue: Value,
  },
  { additionalProperties: false },
);
export const FlagChangesBody = Type.Object(
  { description: Type.String({ maxLength: 500 }) },
  { additionalProperties: false },
);

export const Context = Type.Object(
  {
    key: Type.String({ minLength: 1, maxLength: 200 }),
    attributes: Type.Optional(
      Type.Record(
        Type.String({ pattern: ATTRIBUTE }),
        Type.Union([
          Type.String({ maxLength: 200 }),
          Type.Number(),
          Type.Boolean(),
        ]),
        { maxProperties: 50, additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export const EvaluateBody = Type.Object(
  {
    environment: Environment,
    context: Context,
    keys: Type.Optional(
      Type.Array(Type.String({ pattern: FLAG_KEY }), { maxItems: 100 }),
    ),
  },
  { additionalProperties: false },
);

export type NewFlagBody = Static<typeof NewFlagBody>;
export type EnvironmentSettingsBody = Static<typeof EnvironmentSettings>;

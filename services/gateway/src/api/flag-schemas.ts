import { Type } from "typebox";
import {
  commonErrors,
  errorResponse,
  rateLimitHeaders,
  requiredHeader,
  security,
} from "./schemas.js";

export const FLAG_KEY = "^[a-z0-9][a-z0-9._-]{0,63}$";
const ATTRIBUTE = "^[A-Za-z][A-Za-z0-9_]{0,39}$";

export const FlagValue = Type.Union([
  Type.Boolean(),
  Type.String({ maxLength: 200 }),
]);
export const Environment = Type.Enum(["development", "staging", "production"], {
  description: "Each environment has its own settings",
});
const Percentage = Type.Number({ minimum: 0, maximum: 100 });

export const Condition = Type.Object(
  {
    attribute: Type.String({
      pattern: ATTRIBUTE,
      description:
        '"key" is the user\'s key; anything else is one of their attributes',
    }),
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
export const Rule = Type.Object(
  {
    conditions: Type.Array(Condition, { minItems: 1, maxItems: 10 }),
    value: FlagValue,
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
        { percentage: Percentage, value: FlagValue },
        { additionalProperties: false },
      ),
    ),
    defaultValue: FlagValue,
  },
  { additionalProperties: false },
);

export const EvaluationContext = Type.Object(
  {
    key: Type.String({
      minLength: 1,
      maxLength: 200,
      description:
        "Who is asking, usually the user's ID. Percentages are stable per key.",
    }),
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
    context: EvaluationContext,
    keys: Type.Optional(
      Type.Array(Type.String({ pattern: FLAG_KEY }), {
        maxItems: 100,
        description: "Only these flags (default: all)",
      }),
    ),
  },
  { additionalProperties: false },
);
export const Evaluation = Type.Object(
  {
    environment: Environment,
    flags: Type.Record(
      Type.String(),
      Type.Object(
        {
          value: FlagValue,
          reason: Type.Enum(["off", "rule", "rollout", "default"], {
            description:
              "off: the flag is off; rule: a targeting rule matched (ruleIndex); rollout: the user is in the percentage rollout; default: none of these",
          }),
          ruleIndex: Type.Optional(Type.Integer({ minimum: 0 })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const errors = commonErrors({
  name: "the flags service",
  label: "Flags service",
});

export const evaluateFlagsSchema = {
  operationId: "evaluateFlags",
  tags: ["Feature flags"],
  summary: "Your flags' values for one user",
  description:
    "Every flag of your workspace (or only `keys`), evaluated for the user in `context`, in one environment: off, then the first matching targeting rule, then the percentage rollout, then the default. Unknown keys are left out. Manage flags in the dashboard; changes apply to the next call.",
  security,
  body: EvaluateBody,
  response: {
    200: {
      description: "The values",
      headers: {
        ...rateLimitHeaders,
        "Cache-Control": requiredHeader(Type.String({ enum: ["no-store"] })),
      },
      content: { "application/json": { schema: Evaluation } },
    },
    400: errorResponse(
      "BAD_REQUEST: invalid environment, context or keys.",
      "BAD_REQUEST",
      "body/environment must be equal to one of the allowed values",
    ),
    ...errors,
    413: errorResponse(
      "PAYLOAD_TOO_LARGE: the body is too large.",
      "PAYLOAD_TOO_LARGE",
      "Request body is too large",
    ),
    415: errorResponse(
      "UNSUPPORTED_MEDIA_TYPE: the body must be `application/json`.",
      "UNSUPPORTED_MEDIA_TYPE",
      "Send the request body as application/json",
    ),
  },
};

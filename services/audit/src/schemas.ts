import { Type, type Static } from "typebox";
import {
  ACTION_NAMES,
  ACTOR_TYPES,
  OUTCOMES,
  RESOURCE_TYPES,
} from "./actions.js";

const UUID = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const RESOURCE_ID = "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$";
const IP_CHARACTERS = "^[0-9a-fA-F:.]{2,45}$";
export const TIMESTAMP =
  "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})$";

const literals = <T extends string>(values: readonly T[]) =>
  Type.Union(values.map((value) => Type.Literal(value)));

export const EventBody = Type.Object(
  {
    action: literals(ACTION_NAMES),
    outcome: literals(OUTCOMES),
    actorType: literals(ACTOR_TYPES),
    tenantId: Type.Optional(Type.String({ pattern: UUID })),
    poolId: Type.Optional(Type.String({ pattern: UUID })),
    actorId: Type.Optional(Type.String({ pattern: UUID })),
    resourceId: Type.Optional(Type.String({ pattern: RESOURCE_ID })),
    requestId: Type.Optional(Type.String({ pattern: UUID })),
    sourceIp: Type.Optional(Type.String({ pattern: IP_CHARACTERS })),
  },
  { additionalProperties: false },
);
export type EventBody = Static<typeof EventBody>;

export const EventsQuery = Type.Object(
  {
    from: Type.Optional(Type.String({ pattern: TIMESTAMP })),
    to: Type.Optional(Type.String({ pattern: TIMESTAMP })),
    action: Type.Optional(literals(ACTION_NAMES)),
    outcome: Type.Optional(literals(OUTCOMES)),
    resourceType: Type.Optional(literals(RESOURCE_TYPES)),
    resourceId: Type.Optional(Type.String({ pattern: RESOURCE_ID })),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 100, default: 50 }),
    ),
    cursor: Type.Optional(Type.String({ pattern: "^[1-9][0-9]{0,15}$" })),
  },
  { additionalProperties: false },
);
export type EventsQuery = Static<typeof EventsQuery>;

export const SummaryQuery = Type.Object(
  {
    from: Type.String({ pattern: TIMESTAMP }),
    to: Type.String({ pattern: TIMESTAMP }),
  },
  { additionalProperties: false },
);
export type SummaryQuery = Static<typeof SummaryQuery>;

export const PoolParams = Type.Object(
  { poolId: Type.String({ pattern: UUID }) },
  { additionalProperties: false },
);
export type PoolParams = Static<typeof PoolParams>;

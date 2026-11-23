import { Type } from "typebox";
import {
  commonErrors,
  errorResponse,
  rateLimitHeaders,
  security,
} from "./schemas.js";

export const TENANT_AUDIT_ACTIONS = [
  "tenant.created",
  "tenant.suspended",
  "api_key.created",
  "api_key.revoked",
  "proxy_connection.created",
  "proxy_connection.updated",
  "proxy_connection.deleted",
  "proxy_connection.used",
  "proxy_connection.denied",
  "secret.created",
  "secret.read",
  "secret.rotated",
  "secret.deleted",
  "file.uploaded",
  "file.downloaded",
  "file.deleted",
  "user.signed_up",
  "user.logged_in",
  "user.login_failed",
  "user.logged_out",
  "user.password_changed",
  "membership.added",
  "membership.removed",
  "user.profile_updated",
  "user.session_revoked",
  "user.deleted",
  "user_pool.created",
  "user_pool.updated",
  "user_pool.deleted",
  "pool_user.signed_up",
  "pool_user.updated",
  "pool_user.deleted",
  "pool_user.password_reset",
  "pool_user.password_changed",
  "pool_user.logged_in",
  "pool_user.login_failed",
  "pool_user.logged_out",
  "pool_user.token_reused",
  "pool_role.created",
  "pool_role.updated",
  "pool_role.deleted",
  "pool_user.role_added",
  "pool_user.role_removed",
  "feature_flag.created",
  "feature_flag.updated",
  "feature_flag.toggled",
  "feature_flag.deleted",
  "secret.revealed",
] as const;

export const TENANT_RESOURCE_TYPES = [
  "tenant",
  "api_key",
  "proxy_connection",
  "secret",
  "file",
  "user",
  "membership",
  "user_pool",
  "pool_user",
  "pool_role",
  "feature_flag",
] as const;

const OUTCOMES = ["success", "denied", "failure"] as const;
const TIMESTAMP =
  "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})$";

const Action = Type.Enum([...TENANT_AUDIT_ACTIONS], {
  description: "What happened",
});
const Outcome = Type.Enum([...OUTCOMES], {
  description:
    "success; denied (e.g. a proxy target that isn't allowed); failure",
});
const ResourceType = Type.Enum([...TENANT_RESOURCE_TYPES]);

export const AuditEventsQuery = Type.Object(
  {
    from: Type.Optional(
      Type.String({
        pattern: TIMESTAMP,
        description: "Only events at or after this time (ISO 8601)",
      }),
    ),
    to: Type.Optional(
      Type.String({
        pattern: TIMESTAMP,
        description: "Only events before this time (ISO 8601)",
      }),
    ),
    action: Type.Optional(Action),
    outcome: Type.Optional(Outcome),
    resourceType: Type.Optional(ResourceType),
    resourceId: Type.Optional(
      Type.String({
        pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$",
        description: "e.g. a file ID or a secret's name",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 100,
        default: 50,
        description: "Page size (1-100, default 50)",
      }),
    ),
    cursor: Type.Optional(
      Type.String({
        pattern: "^[1-9][0-9]{0,15}$",
        description: "`nextCursor` from the previous page",
      }),
    ),
  },
  { additionalProperties: false },
);

const AuditEvent = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    occurredAt: Type.String({ format: "date-time" }),
    actorType: Type.Enum(["api_key", "user", "admin", "operator", "service"], {
      description:
        "Who did it: one of your API keys, a dashboard user, a platform administrator, or a platform service",
    }),
    actorId: Type.String({
      nullable: true,
      description:
        "The API key's or dashboard user's ID (never a key, password or token), if any",
    }),
    action: Action,
    resourceType: ResourceType,
    resourceId: Type.String({
      nullable: true,
      description: "The file ID, secret name, key ID, connection name...",
    }),
    outcome: Outcome,
    requestId: Type.String({
      format: "uuid",
      nullable: true,
      description: "The X-Request-Id of the request that caused it",
    }),
    sourceIp: Type.String({
      nullable: true,
      description: "The client's IP address, as the gateway saw it",
    }),
  },
  { additionalProperties: false },
);

export const POOL_AUDIT_ACTIONS = [
  "pool_user.signed_up",
  "pool_user.updated",
  "pool_user.deleted",
  "pool_user.password_reset",
  "pool_user.password_changed",
  "pool_user.logged_in",
  "pool_user.login_failed",
  "pool_user.logged_out",
  "pool_user.token_reused",
  "pool_user.unlocked",
  "pool_role.created",
  "pool_role.updated",
  "pool_role.deleted",
  "pool_user.role_added",
  "pool_user.role_removed",
] as const;
const POOL_RESOURCE_TYPES = ["pool_user", "pool_role"] as const;

export const PoolAuditEventsQuery = Type.Object(
  {
    ...AuditEventsQuery.properties,
    action: Type.Optional(
      Type.Enum([...POOL_AUDIT_ACTIONS], { description: "What happened" }),
    ),
    resourceType: Type.Optional(Type.Enum([...POOL_RESOURCE_TYPES])),
  },
  { additionalProperties: false },
);

export const PoolAuditPage = Type.Object(
  {
    events: Type.Array(
      Type.Object(
        {
          ...AuditEvent.properties,
          action: Type.Enum([...POOL_AUDIT_ACTIONS], {
            description: "What happened",
          }),
          resourceType: Type.Enum([...POOL_RESOURCE_TYPES]),
        },
        { additionalProperties: false },
      ),
    ),
    nextCursor: Type.String({
      nullable: true,
      description:
        "Pass as `cursor` to get the next page; null when there are no more.",
    }),
  },
  { additionalProperties: false },
);

export const listAuditEventsSchema = {
  operationId: "listAuditEvents",
  tags: ["Audit"],
  summary: "List your audit events",
  description:
    "Your tenant's tamper-evident audit log, newest first: API keys, secrets, files and proxy connections. Never secret values, keys or file contents. Filter by time, action, outcome and resource; page with `cursor`.",
  security,
  querystring: AuditEventsQuery,
  response: {
    200: {
      description: "One page of events",
      headers: rateLimitHeaders,
      content: {
        "application/json": {
          schema: Type.Object(
            {
              events: Type.Array(AuditEvent),
              nextCursor: Type.String({
                nullable: true,
                description:
                  "Pass as `cursor` to get the next page; null when there are no more.",
              }),
            },
            { additionalProperties: false },
          ),
          example: {
            events: [
              {
                id: "8a4c6f0e-2b1d-4e6a-9c3f-5d7e8f9a0b1c",
                occurredAt: "2026-11-05T09:30:00.000Z",
                actorType: "api_key",
                actorId: "0d1f3c5e-7a9b-4c2d-8e6f-1a3b5c7d9e0f",
                action: "secret.read",
                resourceType: "secret",
                resourceId: "db-password",
                outcome: "success",
                requestId: "3f2c9b1e-6a4d-4c8e-9f1a-2b3c4d5e6f70",
                sourceIp: "203.0.113.7",
              },
            ],
            nextCursor: null,
          },
        },
      },
    },
    400: errorResponse(
      "BAD_REQUEST: an invalid filter or cursor.",
      "BAD_REQUEST",
      "querystring/action must be equal to one of the allowed values",
    ),
    ...commonErrors({ name: "the audit log", label: "Audit service" }),
  },
};

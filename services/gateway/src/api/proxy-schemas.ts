import { Type, type Static } from "typebox";
import { POLICY_METHODS } from "../services/policy.service.js";
import {
  commonErrors,
  errorResponse,
  rateLimitHeaders,
  security,
} from "./schemas.js";

const NAME_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$";
const HEADER_NAME_PATTERN = "^[A-Za-z0-9][A-Za-z0-9-]{0,63}$";
const HEADER_PREFIX_PATTERN = "^[\\x20-\\x7e]{0,32}$";

const PROXY_ERROR_CODES = [
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "PAYLOAD_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
  "UPSTREAM_UNAVAILABLE",
  "SERVICE_UNAVAILABLE",
  "UPSTREAM_TIMEOUT",
  "SECRETS_SEALED",
  "PROXY_SECRET_MISSING",
  "PROXY_TARGET_BLOCKED",
  "UPSTREAM_REDIRECT",
] as const;
export type ProxyErrorCode =
  | (typeof PROXY_ERROR_CODES)[number]
  | "PROXY_POLICY_DENIED"
  | "PROXY_RATE_LIMITED";

function proxyErrorResponse(extraCodes: string[] = []) {
  return Type.Object(
    {
      error: Type.Object(
        {
          code: Type.Enum([...PROXY_ERROR_CODES, ...extraCodes], {
            description: "Stable, machine-readable error code",
          }),
          message: Type.String({ description: "Human-readable explanation" }),
          requestId: Type.String({ format: "uuid" }),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  );
}
const ProxyErrorResponse = proxyErrorResponse();

function proxyError(
  description: string,
  code: ProxyErrorCode,
  message: string,
  extraCode?: "PROXY_POLICY_DENIED" | "PROXY_RATE_LIMITED",
) {
  return errorResponse(
    description,
    code,
    message,
    extraCode ? proxyErrorResponse([extraCode]) : ProxyErrorResponse,
  );
}

const errors = commonErrors({
  name: "the outside API",
  label: "The outside API",
  schema: ProxyErrorResponse,
});

export const ConnectionName = Type.String({
  pattern: NAME_PATTERN,
  description: "1-128 characters: letters, digits, `_`, `-` and `.`",
  example: "payments",
});

export const ConnectionParams = Type.Object({ name: ConnectionName });

const PolicyPath = Type.String({
  pattern: "^(/([A-Za-z0-9._~-]+|\\*))+$|^/$",
  maxLength: 512,
  description:
    "A path below the base URL. `*` matches exactly one path segment, e.g. `/charges/*`.",
  example: "/charges",
});

export const ConnectionPolicy = Type.Object(
  {
    allowedRoutes: Type.Optional(
      Type.Array(
        Type.Object(
          {
            method: Type.Enum([...POLICY_METHODS]),
            path: PolicyPath,
          },
          { additionalProperties: false },
        ),
        {
          minItems: 1,
          maxItems: 20,
          description:
            "Only these methods and paths may be called (HEAD counts as GET). Anything else is refused with 403 PROXY_POLICY_DENIED.",
        },
      ),
    ),
    rateLimit: Type.Optional(
      Type.Object(
        {
          requests: Type.Integer({ minimum: 1, maximum: 10_000 }),
          windowSeconds: Type.Integer({ minimum: 1, maximum: 86_400 }),
        },
        {
          additionalProperties: false,
          description:
            "At most `requests` calls through this connection per `windowSeconds`. Over it: 429 PROXY_RATE_LIMITED.",
        },
      ),
    ),
    amountLimit: Type.Optional(
      Type.Object(
        {
          field: Type.String({
            pattern: "^[A-Za-z_][A-Za-z0-9_]{0,63}$",
            description:
              "A top-level field of the JSON request body holding a whole, positive amount, e.g. `amount` (in the smallest unit, like cents).",
            example: "amount",
          }),
          maxPerRequest: Type.Integer({ minimum: 1, maximum: 1e12 }),
          maxPerDay: Type.Integer({ minimum: 1, maximum: 1e12 }),
        },
        {
          additionalProperties: false,
          description:
            "For POST, PUT and PATCH calls: the body must be JSON (at most 16 KiB) with a whole, positive amount at `field`, at most `maxPerRequest`, and the day's total (UTC) at most `maxPerDay`. An amount is given back if the outside API answers with an error or can't be reached.",
        },
      ),
    ),
  },
  {
    additionalProperties: false,
    description:
      "Optional limits on what may be done through this connection. Without a policy, any method and path below the base URL is allowed.",
  },
);
export type ConnectionPolicyBody = Static<typeof ConnectionPolicy>;

const policyExample = {
  allowedRoutes: [{ method: "POST", path: "/charges" }],
  rateLimit: { requests: 20, windowSeconds: 60 },
  amountLimit: { field: "amount", maxPerRequest: 50_000, maxPerDay: 200_000 },
};

export const ConnectionBody = Type.Object(
  {
    baseUrl: Type.String({
      maxLength: 2048,
      description:
        "Where requests go, e.g. `https://api.example.com/v1`. Must be https://, without a username, password, query or fragment, and its host must be on the server's allowlist.",
      example: "https://api.example.com/v1",
    }),
    secretName: Type.String({
      pattern: NAME_PATTERN,
      description:
        "Name of your secret (saved with PUT /v1/secrets/{name}) whose latest value is added to every request. Only the name is stored here.",
      example: "payments-api-key",
    }),
    headerName: Type.String({
      pattern: HEADER_NAME_PATTERN,
      description:
        "The header the secret goes in, e.g. `Authorization` or `X-Api-Key`. Not allowed: Host, Cookie, Content-Length and other headers the proxy manages.",
      example: "Authorization",
    }),
    headerPrefix: Type.Optional(
      Type.String({
        pattern: HEADER_PREFIX_PATTERN,
        description:
          'Text before the secret in the header, e.g. "Bearer ". Default: none.',
        example: "Bearer ",
      }),
    ),
    policy: Type.Optional(ConnectionPolicy),
  },
  { additionalProperties: false },
);
export type ConnectionBody = Static<typeof ConnectionBody>;

const Connection = Type.Object(
  {
    name: ConnectionName,
    baseUrl: Type.String({ example: "https://api.example.com/v1" }),
    secretName: Type.String({ example: "payments-api-key" }),
    headerName: Type.String({ example: "Authorization" }),
    headerPrefix: Type.String({ example: "Bearer " }),
    policy: Type.Object(ConnectionPolicy.properties, {
      additionalProperties: false,
      nullable: true,
      description: "The connection's policy, or null if it has none.",
    }),
    createdAt: Type.String({ format: "date-time" }),
    updatedAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);

const connectionExample = {
  name: "payments",
  baseUrl: "https://api.example.com/v1",
  secretName: "payments-api-key",
  headerName: "Authorization",
  headerPrefix: "Bearer ",
  policy: policyExample,
  createdAt: "2026-11-05T09:30:00.000Z",
  updatedAt: "2026-11-05T09:30:00.000Z",
};

function ok(description: string, schema: object, example: object) {
  return {
    description,
    headers: rateLimitHeaders,
    content: { "application/json": { schema, example } },
  };
}

const badRequest = proxyError(
  "BAD_REQUEST: invalid name or settings, or a base URL that isn't allowed (the message says why).",
  "BAD_REQUEST",
  "baseUrl must start with https://",
);
const notFound = proxyError(
  'NOT_FOUND: no such connection for this tenant (another tenant\'s is also "not found").',
  "NOT_FOUND",
  "Connection not found",
);

const tags = ["Proxy"];

export const putConnectionSchema = {
  operationId: "putProxyConnection",
  tags,
  summary: "Create or replace a proxy connection",
  description:
    "Saves where the proxy route sends requests and which of your secrets it adds. The secret's value is never stored here or returned.",
  security,
  params: ConnectionParams,
  body: ConnectionBody,
  response: {
    200: ok("Replaced", Connection, connectionExample),
    201: ok("Created", Connection, connectionExample),
    400: badRequest,
    ...errors,
    415: proxyError(
      "UNSUPPORTED_MEDIA_TYPE: the body must be `application/json`.",
      "UNSUPPORTED_MEDIA_TYPE",
      "Send the request body as application/json",
    ),
  },
};

export const listConnectionsSchema = {
  operationId: "listProxyConnections",
  tags,
  summary: "List proxy connections",
  description: "Your connections, by name. Never includes secret values.",
  security,
  response: {
    200: ok(
      "Your connections",
      Type.Object(
        { connections: Type.Array(Connection) },
        { additionalProperties: false },
      ),
      { connections: [connectionExample] },
    ),
    ...errors,
  },
};

export const deleteConnectionSchema = {
  operationId: "deleteProxyConnection",
  tags,
  summary: "Delete a proxy connection",
  description: "The secret it used is not deleted.",
  security,
  params: ConnectionParams,
  response: {
    204: { type: "null", description: "Deleted", headers: rateLimitHeaders },
    400: badRequest,
    ...errors,
    404: notFound,
  },
};

const ConnectionUsage = Type.Object(
  {
    name: ConnectionName,
    day: Type.String({
      format: "date",
      description: "Today (UTC), the day the amount total counts",
    }),
    calls: Type.Object(
      {
        used: Type.Integer({ description: "Calls in the current window" }),
        limit: Type.Integer(),
        windowSeconds: Type.Integer(),
        resetSeconds: Type.Integer({
          description: "Seconds until the window resets",
        }),
      },
      {
        additionalProperties: false,
        nullable: true,
        description: "null without a rate limit",
      },
    ),
    amount: Type.Object(
      {
        field: Type.String(),
        usedToday: Type.Integer(),
        maxPerDay: Type.Integer(),
        maxPerRequest: Type.Integer(),
      },
      {
        additionalProperties: false,
        nullable: true,
        description: "null without an amount limit",
      },
    ),
  },
  { additionalProperties: false },
);

export const connectionUsageSchema = {
  operationId: "getProxyConnectionUsage",
  tags,
  summary: "A connection's usage against its policy",
  description:
    "Calls in the current rate-limit window and today's amount total (UTC), for the limits the connection's policy has.",
  security,
  params: ConnectionParams,
  response: {
    200: ok("Usage", ConnectionUsage, {
      name: "payments",
      day: "2026-11-12",
      calls: { used: 3, limit: 20, windowSeconds: 60, resetSeconds: 41 },
      amount: {
        field: "amount",
        usedToday: 7_200,
        maxPerDay: 200_000,
        maxPerRequest: 50_000,
      },
    }),
    400: badRequest,
    ...errors,
    404: notFound,
  },
};

export const ProxyParams = Type.Object({
  connection: ConnectionName,
  "*": Type.String({
    description:
      "The path to call, below the connection's base URL (it can't leave the base path or change the host). The query string is passed on as is.",
    example: "charges/ch_123",
  }),
});
export type ProxyParams = Static<typeof ProxyParams>;

export const proxySchema = {
  operationId: "proxy",
  tags,
  summary: "Call an outside API with your stored secret",
  description: [
    "Forwards the request (method, path below the base URL, query, headers and body) to the connection's base URL, with the latest value of its secret added in its header. The secret is never returned.",
    "",
    "Removed before forwarding: your Authorization, Cookie and X-Tenant-Id headers, any header with the connection's header name, and hop-by-hop headers. The outside API's answer is passed back as is (any status), without hop-by-hop headers or Set-Cookie. Redirects are not followed: they become `502 UPSTREAM_REDIRECT`.",
    "",
    "Note: we can't stop the outside service from echoing the key in its own response.",
  ].join("\n"),
  security,
  params: ProxyParams,
  response: {
    default: {
      description:
        "The outside API's response, passed through unchanged (except as described above).",
    },
    400: proxyError(
      "BAD_REQUEST: invalid connection name or a path that isn't allowed.",
      "BAD_REQUEST",
      "the path isn't allowed",
    ),
    ...errors,
    403: proxyError(
      "PROXY_POLICY_DENIED: the connection's policy refused the call (route not allowed, missing or too large amount, daily limit reached); the secret was not read. PROXY_TARGET_BLOCKED: the connection's host isn't allowed (not on the allowlist, or it resolves to a private, loopback, link-local or metadata address). FORBIDDEN: the key's tenant is suspended.",
      "PROXY_TARGET_BLOCKED",
      "the host resolves to a private or loopback address",
      "PROXY_POLICY_DENIED",
    ),
    404: notFound,
    409: proxyError(
      "PROXY_SECRET_MISSING: the connection's secret doesn't exist (save it with PUT /v1/secrets/{name}).",
      "PROXY_SECRET_MISSING",
      "The connection's secret doesn't exist",
    ),
    413: proxyError(
      "PAYLOAD_TOO_LARGE: the request body is larger than the allowed maximum.",
      "PAYLOAD_TOO_LARGE",
      "The upload is larger than the allowed maximum",
    ),
    429: proxyError(
      "PROXY_RATE_LIMITED: the connection's policy allows no more calls in this window (see Retry-After). RATE_LIMITED: your API key's own limit.",
      "PROXY_RATE_LIMITED",
      "The connection's rate limit is reached",
      "PROXY_RATE_LIMITED",
    ),
    502: proxyError(
      "UPSTREAM_REDIRECT: the outside API answered with a redirect, which isn't followed (so the secret can't be sent elsewhere). UPSTREAM_UNAVAILABLE: the outside API, or the secrets service, can't be reached.",
      "UPSTREAM_REDIRECT",
      "The outside API answered with a redirect, which isn't followed",
    ),
    503: proxyError(
      "SECRETS_SEALED: the secrets service is sealed until an operator unseals it. SERVICE_UNAVAILABLE: temporarily unavailable, or the connection has a rate or amount limit and its counters can't be reached (policies fail closed).",
      "SECRETS_SEALED",
      "The secrets service is sealed until an operator unseals it",
    ),
  },
};

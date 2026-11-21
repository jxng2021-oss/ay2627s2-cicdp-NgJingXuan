import { Type, type Static } from "typebox";
import {
  commonErrors,
  errorResponse,
  rateLimitHeaders,
  requiredHeader,
  SecretsErrorResponse,
  type SecretsErrorCode,
  security,
} from "./schemas.js";

const SECRET_NAME_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$";

const SecretName = Type.String({
  pattern: SECRET_NAME_PATTERN,
  description:
    "1-128 characters: letters, digits, `_`, `-` and `.`, starting with a letter or digit. Case-sensitive.",
  example: "database-password",
});
const Version = Type.Integer({ minimum: 1, example: 3 });
const Timestamp = Type.String({
  format: "date-time",
  example: "2026-11-04T09:30:00.000Z",
});
const NextCursor = Type.String({
  nullable: true,
  description:
    "Pass as `cursor` to get the next page; null when there are no more.",
});
const Limit = Type.Optional(
  Type.Integer({
    minimum: 1,
    maximum: 100,
    default: 20,
    description: "Page size (1-100, default 20)",
  }),
);

export const SecretParams = Type.Object({ name: SecretName });
export type SecretParams = Static<typeof SecretParams>;

export const SecretValueBody = Type.Object(
  {
    value: Type.String({
      description:
        "The secret, as text (encode binary data, e.g. as base64). At most 64 KiB of UTF-8 by default.",
      example: "correct-horse-battery-staple",
    }),
  },
  { additionalProperties: false },
);

export const ReadSecretQuery = Type.Object({
  version: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 2_147_483_647,
      description: "A specific version (default: the latest)",
    }),
  ),
});

export const ListSecretsQuery = Type.Object({
  limit: Limit,
  cursor: Type.Optional(
    Type.String({
      pattern: SECRET_NAME_PATTERN,
      description: "`nextCursor` from the previous page",
    }),
  ),
});

export const ListVersionsQuery = Type.Object({
  limit: Limit,
  cursor: Type.Optional(
    Type.String({
      pattern: "^[1-9][0-9]{0,9}$",
      description: "`nextCursor` from the previous page",
    }),
  ),
});

const SavedVersion = Type.Object(
  { name: SecretName, version: Version, createdAt: Timestamp },
  { additionalProperties: false },
);

const SecretList = Type.Object(
  {
    secrets: Type.Array(
      Type.Object(
        {
          name: SecretName,
          latestVersion: Version,
          createdAt: Timestamp,
          updatedAt: Timestamp,
        },
        { additionalProperties: false },
      ),
    ),
    nextCursor: NextCursor,
  },
  { additionalProperties: false },
);

const VersionList = Type.Object(
  {
    name: SecretName,
    versions: Type.Array(
      Type.Object(
        { version: Version, createdAt: Timestamp },
        { additionalProperties: false },
      ),
    ),
    nextCursor: NextCursor,
  },
  { additionalProperties: false },
);

function secretsError(
  description: string,
  code: SecretsErrorCode,
  message: string,
) {
  return errorResponse(description, code, message, SecretsErrorResponse);
}

const noStoreHeaders = {
  ...rateLimitHeaders,
  "Cache-Control": requiredHeader(
    Type.String({
      enum: ["no-store"],
      description: "Always `no-store`: responses may contain secret values.",
    }),
  ),
};

function ok(description: string, schema: object, example: object) {
  return {
    description,
    headers: noStoreHeaders,
    content: { "application/json": { schema, example } },
  };
}

const savedExample = {
  name: "database-password",
  version: 3,
  createdAt: "2026-11-04T09:30:00.000Z",
};

const errors = {
  ...commonErrors({
    name: "the secrets service",
    label: "Secrets service",
    schema: SecretsErrorResponse,
  }),
  503: {
    ...secretsError(
      "SECRETS_SEALED: the secrets service is sealed (for example after a restart) until an operator unseals it; retry later. SERVICE_UNAVAILABLE: temporarily unavailable, or the audit log is unavailable (every read and change is recorded first, so it was refused and nothing changed).",
      "SECRETS_SEALED",
      "The secrets service is sealed until an operator unseals it",
    ),
    headers: {
      ...secretsError("", "SECRETS_SEALED", "").headers,
      "Retry-After": Type.Integer({
        description: "Seconds to wait before retrying",
      }),
    },
  },
};
const badRequest = secretsError(
  "BAD_REQUEST: invalid name, query parameter or body.",
  "BAD_REQUEST",
  "params/name must match pattern",
);
const notFound = secretsError(
  "NOT_FOUND: no such secret (or version) for this tenant. Another tenant's secret is the same 404.",
  "NOT_FOUND",
  "Secret not found",
);
const bodyErrors = {
  413: secretsError(
    "PAYLOAD_TOO_LARGE: the value is larger than the allowed maximum (64 KiB by default).",
    "PAYLOAD_TOO_LARGE",
    "The secret value is larger than the allowed maximum",
  ),
  415: secretsError(
    "UNSUPPORTED_MEDIA_TYPE: the body must be `application/json`.",
    "UNSUPPORTED_MEDIA_TYPE",
    "Send the request body as application/json",
  ),
};

const tags = ["Secrets"];

export const listSecretsSchema = {
  operationId: "listSecrets",
  tags,
  summary: "List secrets",
  description:
    "Names and metadata of your secrets, sorted by name. **Never includes values.**",
  security,
  querystring: ListSecretsQuery,
  response: {
    200: ok("One page of secrets", SecretList, {
      secrets: [
        {
          name: "database-password",
          latestVersion: 3,
          createdAt: "2026-11-01T08:00:00.000Z",
          updatedAt: "2026-11-04T09:30:00.000Z",
        },
      ],
      nextCursor: null,
    }),
    400: badRequest,
    ...errors,
  },
};

export const putSecretSchema = {
  operationId: "putSecret",
  tags,
  summary: "Save a secret",
  description:
    "Saves the value as a new version: version 1 creates the secret (201), later saves add versions (200). Values are encrypted before they are stored.",
  security,
  params: SecretParams,
  body: SecretValueBody,
  response: {
    200: ok("Saved as a new version", SavedVersion, savedExample),
    201: ok("Created (version 1)", SavedVersion, {
      ...savedExample,
      version: 1,
    }),
    400: badRequest,
    ...errors,
    ...bodyErrors,
  },
};

export const readSecretSchema = {
  operationId: "readSecret",
  tags,
  summary: "A secret's metadata (never its value)",
  description:
    "The latest version's number and date, or a specific one's with `?version=N`. **Never the value:** secret values are write-only (docs/decisions/0021). Save or rotate them, and use them through a proxy connection, which adds the value to the outgoing request without returning it.",
  security,
  params: SecretParams,
  querystring: ReadSecretQuery,
  response: {
    200: ok("The version's metadata", SavedVersion, savedExample),
    400: badRequest,
    ...errors,
    404: notFound,
  },
};

export const listVersionsSchema = {
  operationId: "listSecretVersions",
  tags,
  summary: "List a secret's versions",
  description:
    "Version numbers and dates, newest first. **Never includes values.**",
  security,
  params: SecretParams,
  querystring: ListVersionsQuery,
  response: {
    200: ok("One page of versions", VersionList, {
      name: "database-password",
      versions: [
        { version: 3, createdAt: "2026-11-04T09:30:00.000Z" },
        { version: 2, createdAt: "2026-11-02T10:00:00.000Z" },
      ],
      nextCursor: "2",
    }),
    400: badRequest,
    ...errors,
    404: notFound,
  },
};

export const rotateSecretSchema = {
  operationId: "rotateSecret",
  tags,
  summary: "Rotate a secret",
  description:
    "Saves a new value as the next version of an existing secret (404 if it doesn't exist). Older versions stay readable with `?version=N`.",
  security,
  params: SecretParams,
  body: SecretValueBody,
  response: {
    200: ok("Saved as the next version", SavedVersion, savedExample),
    400: badRequest,
    ...errors,
    404: notFound,
    ...bodyErrors,
  },
};

export const deleteSecretSchema = {
  operationId: "deleteSecret",
  tags,
  summary: "Delete a secret",
  description:
    "Deletes the secret and every encrypted version. This can't be undone.",
  security,
  params: SecretParams,
  response: {
    204: {
      type: "null",
      description: "Deleted",
      headers: noStoreHeaders,
    },
    400: badRequest,
    ...errors,
    404: notFound,
  },
};

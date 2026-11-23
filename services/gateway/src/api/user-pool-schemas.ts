import { Type } from "typebox";
import {
  commonErrors,
  errorResponse,
  rateLimitHeaders,
  requestIdHeader,
  requiredHeader,
  security,
} from "./schemas.js";

const UUID = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

const ERROR_CODES = [
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "PAYLOAD_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
  "UPSTREAM_UNAVAILABLE",
  "SERVICE_UNAVAILABLE",
  "UPSTREAM_TIMEOUT",
  "SECRETS_SEALED",
] as const;

export const UserPoolErrorResponse = Type.Object(
  {
    error: Type.Object(
      {
        code: Type.Enum([...ERROR_CODES], {
          description: "Stable, machine-readable error code",
        }),
        message: Type.String({ description: "Human-readable explanation" }),
        requestId: Type.String({
          format: "uuid",
          description:
            "Same as the X-Request-Id header. Quote it when reporting a problem.",
        }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const poolError = (
  description: string,
  code: (typeof ERROR_CODES)[number],
  message: string,
) => errorResponse(description, code, message, UserPoolErrorResponse);

export const PoolParams = Type.Object({
  poolId: Type.String({
    pattern: UUID,
    description: "The user pool's ID (from the dashboard)",
  }),
});
export const UserParams = Type.Object({
  poolId: Type.String({ pattern: UUID }),
  userId: Type.String({ pattern: UUID }),
});

const Email = Type.String({
  minLength: 3,
  maxLength: 254,
  pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$",
  description: "Compared lower-cased",
  example: "ada@example.com",
});
const Password = Type.String({
  minLength: 1,
  maxLength: 128,
  description:
    "At least the pool's minimum length (12 by default); very common passwords are refused",
});
export const Attributes = Type.Record(
  Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_]{0,39}$" }),
  Type.Union([Type.String({ maxLength: 200 }), Type.Number(), Type.Boolean()]),
  {
    maxProperties: 20,
    additionalProperties: false,
    description:
      "Your app's own fields for the user (at most 20, short plain values). They are included in the user's tokens.",
    example: { name: "Ada", plan: "pro" },
  },
);
const RefreshToken = Type.String({
  pattern: "^[A-Za-z0-9_-]{43}$",
  description: "The refresh token from a sign-in or refresh",
});

export const RoleName = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-z0-9][a-z0-9_.:-]{0,63}$",
  description:
    "Lower case letters, digits, dots, colons, dashes or underscores",
  example: "support",
});
export const Permission = Type.String({
  minLength: 1,
  maxLength: 100,
  pattern: "^(\\*|[A-Za-z0-9][A-Za-z0-9_.:-]{0,98}(:\\*|\\.\\*)?)$",
  description:
    'Your app\'s own word for something a user may do, like "orders:refund". A trailing ":*" or ".*" covers everything under it; "*" alone covers everything.',
  example: "orders:refund",
});
const Permissions = Type.Array(Permission, {
  maxItems: 100,
  uniqueItems: true,
});
const RoleDescription = Type.String({ maxLength: 200 });

export const Role = Type.Object(
  {
    name: RoleName,
    description: RoleDescription,
    permissions: Type.Array(Permission),
    userCount: Type.Integer({
      minimum: 0,
      description: "Users with this role",
    }),
    createdAt: Type.String({ format: "date-time" }),
    updatedAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);
export const RoleList = Type.Object(
  { roles: Type.Array(Role) },
  { additionalProperties: false },
);
export const NewRoleBody = Type.Object(
  {
    name: RoleName,
    description: Type.Optional(RoleDescription),
    permissions: Permissions,
  },
  { additionalProperties: false },
);
export const RoleChangesBody = Type.Object(
  {
    description: Type.Optional(RoleDescription),
    permissions: Type.Optional(Permissions),
  },
  { additionalProperties: false, minProperties: 1 },
);
export const RoleParams = Type.Object({
  poolId: Type.String({ pattern: UUID }),
  role: RoleName,
});
export const UserRoleParams = Type.Object({
  poolId: Type.String({ pattern: UUID }),
  userId: Type.String({ pattern: UUID }),
  role: RoleName,
});

export const User = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    email: Type.String(),
    status: Type.Enum(["active", "disabled"]),
    locked: Type.Boolean({
      description: "Locked for a while after repeated wrong passwords",
    }),
    passwordResetRequired: Type.Boolean({
      description:
        "An owner asked the user to choose a new password. Signing in still works and says passwordResetRequired; changing the password clears it.",
    }),
    attributes: Attributes,
    roles: Type.Array(Type.String(), {
      description: "The names of the user's roles",
    }),
    createdAt: Type.String({ format: "date-time" }),
    lastLoginAt: Type.String({ format: "date-time", nullable: true }),
  },
  { additionalProperties: false },
);

export const Tokens = Type.Object(
  {
    accessToken: Type.String({
      description:
        "A JWT signed with ES256. Claims: iss (the pool's issuer), sub (the user's ID), aud (the pool's ID), iat, exp, jti, token_use (\"access\"), email, attributes, roles (the names of the user's roles) and permissions (every permission those roles give). Check it with the pool's public keys (jwks.json).",
    }),
    tokenType: Type.Enum(["Bearer"]),
    expiresIn: Type.Integer({
      description: "Seconds until the access token expires",
    }),
    refreshToken: Type.String({
      description:
        "Swap it for new tokens with POST .../sessions/refresh. It works ONCE: each refresh returns a new one. Keep it on your server.",
    }),
    passwordResetRequired: Type.Boolean({
      description:
        "True when an owner asked this user to choose a new password: send them to your change-password page (POST .../users/{userId}/password) before anything else.",
    }),
    user: User,
  },
  { additionalProperties: false },
);

export const Jwks = Type.Object(
  {
    keys: Type.Array(
      Type.Object(
        {
          kty: Type.Enum(["EC"]),
          crv: Type.Enum(["P-256"]),
          x: Type.String(),
          y: Type.String(),
          kid: Type.String({ format: "uuid" }),
          use: Type.Enum(["sig"]),
          alg: Type.Enum(["ES256"]),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const SignUpBody = Type.Object(
  { email: Email, password: Password, attributes: Type.Optional(Attributes) },
  { additionalProperties: false },
);
export const LoginBody = Type.Object(
  { email: Email, password: Password },
  { additionalProperties: false },
);
export const RefreshBody = Type.Object(
  { refreshToken: RefreshToken },
  { additionalProperties: false },
);
export const ChangePasswordBody = Type.Object(
  { currentPassword: Password, newPassword: Password },
  { additionalProperties: false },
);

const noStoreHeaders = {
  ...rateLimitHeaders,
  "Cache-Control": requiredHeader(
    Type.String({
      enum: ["no-store"],
      description: "Always `no-store`: answers may hold tokens.",
    }),
  ),
};

function ok(description: string, schema: object) {
  return {
    description,
    headers: noStoreHeaders,
    content: { "application/json": { schema } },
  };
}

const errors = {
  ...commonErrors({
    name: "the identity service",
    label: "Identity service",
    schema: UserPoolErrorResponse,
  }),
  503: poolError(
    "SECRETS_SEALED: signing tokens needs the vault unsealed (for example after a restart); retry later. SERVICE_UNAVAILABLE: temporarily unavailable, or the audit log is unavailable (changes are recorded first, so it was refused).",
    "SECRETS_SEALED",
    "The secrets service is sealed until an operator unseals it",
  ),
};
const badRequest = poolError(
  "BAD_REQUEST: invalid input, or a password that doesn't meet the pool's rule.",
  "BAD_REQUEST",
  "The password must be at least 12 characters",
);
const poolNotFound = poolError(
  "NOT_FOUND: no such user pool for this key's workspace (another workspace's pool is the same 404).",
  "NOT_FOUND",
  "User pool not found",
);
const userNotFound = poolError(
  "NOT_FOUND: no such pool or user.",
  "NOT_FOUND",
  "User not found",
);
const bodyErrors = {
  413: poolError(
    "PAYLOAD_TOO_LARGE: the body is too large.",
    "PAYLOAD_TOO_LARGE",
    "Request body is too large",
  ),
  415: poolError(
    "UNSUPPORTED_MEDIA_TYPE: the body must be `application/json`.",
    "UNSUPPORTED_MEDIA_TYPE",
    "Send the request body as application/json",
  ),
};
const noContent = (description: string) => ({
  description,
  headers: noStoreHeaders,
});

const tags = ["User pools"];

export const signUpSchema = {
  operationId: "signUpPoolUser",
  tags,
  summary: "Sign a user up",
  description:
    "Creates one of your app's users in the pool. The password is stored only as an Argon2id hash. Call this from your server (the API key never goes to a browser); then sign the user in.",
  security,
  params: PoolParams,
  body: SignUpBody,
  response: {
    201: ok("The new user", User),
    400: badRequest,
    ...errors,
    404: poolNotFound,
    409: poolError(
      "CONFLICT: a user with this email is already in the pool.",
      "CONFLICT",
      "A user with this email already exists",
    ),
    ...bodyErrors,
  },
};

export const getPoolUserSchema = {
  operationId: "getPoolUser",
  tags,
  summary: "A user",
  security,
  params: UserParams,
  response: {
    200: ok("The user", User),
    400: badRequest,
    ...errors,
    404: userNotFound,
  },
};

export const changePasswordSchema = {
  operationId: "changePoolUserPassword",
  tags,
  summary: "A user changes their password",
  description:
    "Needs the current password. Ends all the user's sessions (their refresh tokens stop working).",
  security,
  params: UserParams,
  body: ChangePasswordBody,
  response: {
    204: noContent("Changed"),
    400: badRequest,
    ...errors,
    401: poolError(
      "UNAUTHORIZED: the current password is wrong (or the API key is missing, wrong or revoked).",
      "UNAUTHORIZED",
      "The current password is wrong",
    ),
    404: userNotFound,
    ...bodyErrors,
  },
};

export const signInSchema = {
  operationId: "signInPoolUser",
  tags,
  summary: "Sign a user in",
  description:
    "Returns a signed access token (ES256 JWT) and a refresh token. A wrong password, an unknown email, a disabled user and a locked one (after 5 wrong passwords in a row, for 15 minutes) all get the same 401.",
  security,
  params: PoolParams,
  body: LoginBody,
  response: {
    200: ok("Signed in", Tokens),
    400: badRequest,
    ...errors,
    401: poolError(
      "UNAUTHORIZED: wrong email or password (always the same answer), or the API key is missing, wrong or revoked.",
      "UNAUTHORIZED",
      "Wrong email or password",
    ),
    404: poolNotFound,
    ...bodyErrors,
  },
};

export const refreshSchema = {
  operationId: "refreshPoolUserSession",
  tags,
  summary: "New tokens for a refresh token",
  description:
    "The refresh token works once: the answer has a new one. A refresh token used again after that ends the whole session (someone had a copy), so keep only the latest.",
  security,
  params: PoolParams,
  body: RefreshBody,
  response: {
    200: ok("New tokens", Tokens),
    400: badRequest,
    ...errors,
    401: poolError(
      "UNAUTHORIZED: the refresh token is unknown, already used, revoked or expired (or the API key is missing, wrong or revoked).",
      "UNAUTHORIZED",
      "The refresh token is invalid or has expired",
    ),
    404: poolNotFound,
    ...bodyErrors,
  },
};

export const signOutSchema = {
  operationId: "signOutPoolUser",
  tags,
  summary: "Sign a user out",
  description:
    "The refresh token stops working. (Access tokens can't be recalled: they expire on their own, which is why they're short-lived.) The same answer for any token.",
  security,
  params: PoolParams,
  body: RefreshBody,
  response: {
    204: noContent("Signed out"),
    400: badRequest,
    ...errors,
    404: poolNotFound,
    ...bodyErrors,
  },
};

export const jwksSchema = {
  operationId: "getUserPoolKeys",
  tags,
  summary: "A pool's public keys (JWKS)",
  description:
    "**No API key needed:** the keys can only check tokens, never make them. Use this address with any JWT library to verify access tokens (alg ES256, kid in the token's header). Cacheable for 5 minutes.",
  params: PoolParams,
  response: {
    200: {
      description: "The pool's public keys",
      headers: {
        ...requestIdHeader,
        "Cache-Control": requiredHeader(
          Type.String({ enum: ["public, max-age=300"] }),
        ),
      },
      content: { "application/json": { schema: Jwks } },
    },
    400: badRequest,
    404: poolError(
      "NOT_FOUND: no such user pool.",
      "NOT_FOUND",
      "User pool not found",
    ),
    502: errors[502],
    504: errors[504],
  },
};

const roleTags = ["User pool roles"];
const roleNotFound = poolError(
  "NOT_FOUND: no such pool or role.",
  "NOT_FOUND",
  "Role not found",
);
const userOrRoleNotFound = poolError(
  "NOT_FOUND: no such pool, user or role.",
  "NOT_FOUND",
  "User not found",
);

export const listRolesSchema = {
  operationId: "listPoolRoles",
  tags: roleTags,
  summary: "The pool's roles",
  security,
  params: PoolParams,
  response: {
    200: ok("The roles", RoleList),
    400: badRequest,
    ...errors,
    404: poolNotFound,
  },
};

export const createRoleSchema = {
  operationId: "createPoolRole",
  tags: roleTags,
  summary: "Create a role",
  description:
    "A role is a name your app checks, with the permissions it gives. Give it to users with PUT .../users/{userId}/roles/{role}; it appears in their next access token. At most 50 roles per pool.",
  security,
  params: PoolParams,
  body: NewRoleBody,
  response: {
    201: ok("The new role", Role),
    400: badRequest,
    ...errors,
    404: poolNotFound,
    409: poolError(
      "CONFLICT: a role with this name exists, or the pool has 50 roles.",
      "CONFLICT",
      "A role with this name already exists",
    ),
    ...bodyErrors,
  },
};

export const getRoleSchema = {
  operationId: "getPoolRole",
  tags: roleTags,
  summary: "A role",
  security,
  params: RoleParams,
  response: {
    200: ok("The role", Role),
    400: badRequest,
    ...errors,
    404: roleNotFound,
  },
};

export const updateRoleSchema = {
  operationId: "updatePoolRole",
  tags: roleTags,
  summary: "Change a role's description or permissions",
  description:
    "Users with the role get the new permissions in their next access token (at the latest when their current one expires).",
  security,
  params: RoleParams,
  body: RoleChangesBody,
  response: {
    200: ok("The role", Role),
    400: badRequest,
    ...errors,
    404: roleNotFound,
    ...bodyErrors,
  },
};

export const deleteRoleSchema = {
  operationId: "deletePoolRole",
  tags: roleTags,
  summary: "Delete a role",
  description: "Its users lose it, from their next access token.",
  security,
  params: RoleParams,
  response: {
    204: noContent("Deleted"),
    400: badRequest,
    ...errors,
    404: roleNotFound,
  },
};

export const addUserRoleSchema = {
  operationId: "addPoolUserRole",
  tags: roleTags,
  summary: "Give a user a role",
  description:
    "Safe to repeat. The role is in the user's next access token. At most 20 roles per user.",
  security,
  params: UserRoleParams,
  response: {
    200: ok("The user, with their roles", User),
    400: badRequest,
    ...errors,
    404: userOrRoleNotFound,
    409: poolError(
      "CONFLICT: the user already has 20 roles.",
      "CONFLICT",
      "A user can have at most 20 roles",
    ),
  },
};

export const removeUserRoleSchema = {
  operationId: "removePoolUserRole",
  tags: roleTags,
  summary: "Take a role from a user",
  description: "Safe to repeat. Gone from the user's next access token.",
  security,
  params: UserRoleParams,
  response: {
    200: ok("The user, with their roles", User),
    400: badRequest,
    ...errors,
    404: userOrRoleNotFound,
  },
};

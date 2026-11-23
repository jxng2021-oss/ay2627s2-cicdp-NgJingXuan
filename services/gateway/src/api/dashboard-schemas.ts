import {
  NewRoleBody as PoolNewRoleBody,
  Role as PoolRole,
  RoleChangesBody as PoolRoleChangesBody,
  RoleList as PoolRoleList,
  RoleName as PoolRoleName,
} from "./user-pool-schemas.js";
import { Type, type TObject, type TProperties } from "typebox";
import {
  listAuditEventsSchema,
  PoolAuditEventsQuery,
  PoolAuditPage,
} from "./audit-schemas.js";
import {
  EnvironmentSettings as FlagEnvironmentSettings,
  Environment as FlagEnvironment,
  EvaluateBody as FlagEvaluateBody,
  Evaluation as FlagEvaluation,
  FLAG_KEY,
  FlagValue,
} from "./flag-schemas.js";
import {
  connectionUsageSchema,
  deleteConnectionSchema,
  listConnectionsSchema,
  putConnectionSchema,
} from "./proxy-schemas.js";
import {
  deleteFileSchema,
  downloadFileSchema,
  errorResponse,
  fileMetadataSchema,
  listFilesSchema,
  uploadFileSchema,
  usageSchema,
} from "./schemas.js";
import {
  deleteSecretSchema,
  listSecretsSchema,
  listVersionsSchema,
  putSecretSchema,
  rotateSecretSchema,
} from "./secrets-schemas.js";
import { MAX_PASSWORD_LENGTH } from "../services/password.service.js";

const UUID = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const security = [{ session: [] }];

const error = (description: string, code: string, message: string) =>
  errorResponse(description, code, message, DashboardErrorResponse);

export const DashboardErrorResponse = Type.Object(
  {
    error: Type.Object(
      {
        code: Type.String({
          description: "Stable, machine-readable error code",
        }),
        message: Type.String(),
        requestId: Type.String({ format: "uuid" }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const authErrors = {
  400: error(
    "BAD_REQUEST: invalid input.",
    "BAD_REQUEST",
    "body/email must match format",
  ),
  403: error(
    "FORBIDDEN: the request's Origin isn't the dashboard's, its CSRF token is missing or wrong, or your role can't do this.",
    "FORBIDDEN",
    "A valid CSRF token is required",
  ),
  429: error(
    "RATE_LIMITED: too many attempts; retry after `Retry-After` seconds.",
    "RATE_LIMITED",
    "Too many requests, try again later",
  ),
  503: error(
    "SERVICE_UNAVAILABLE: temporarily unavailable (rate limiting or the audit log is down).",
    "SERVICE_UNAVAILABLE",
    "Service temporarily unavailable",
  ),
};
const notSignedIn = error(
  "UNAUTHORIZED: not signed in, or the session expired.",
  "UNAUTHORIZED",
  "Sign in first",
);

const Email = Type.String({
  minLength: 3,
  maxLength: 254,
  pattern: "^[^\\s@]+@[^\\s@]+$",
});
const Password = Type.String({ minLength: 1, maxLength: MAX_PASSWORD_LENGTH });

const WorkspaceSummary = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    name: Type.String(),
    role: Type.Enum(["owner", "member"]),
  },
  { additionalProperties: false },
);
const Me = Type.Object(
  {
    user: Type.Object(
      {
        id: Type.String({ format: "uuid" }),
        email: Type.String(),
        displayName: Type.String({ nullable: true }),
        createdAt: Type.String({ format: "date-time" }),
        hasPassword: Type.Boolean({
          description:
            "False for accounts that only sign in with Google or GitHub",
        }),
      },
      { additionalProperties: false },
    ),
    workspaces: Type.Array(WorkspaceSummary),
  },
  { additionalProperties: false },
);
const meResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: Me } },
});

export const SignUpBody = Type.Object(
  {
    email: Email,
    password: Password,
    workspaceName: Type.String({ minLength: 1, maxLength: 100 }),
  },
  { additionalProperties: false },
);
export const LoginBody = Type.Object(
  { email: Email, password: Password },
  { additionalProperties: false },
);
export const ChangePasswordBody = Type.Object(
  { currentPassword: Password, newPassword: Password },
  { additionalProperties: false },
);

export const signUpSchema = {
  operationId: "signUp",
  tags: ["Auth"],
  summary: "Create an account and its first workspace",
  description:
    "Creates the user, a workspace and an owner membership, and signs in (sets the session cookie). The password needs at least 12 characters and mustn't be a common one. Needs the dashboard's Origin.",
  body: SignUpBody,
  response: {
    201: meResponse("Signed up and signed in"),
    ...authErrors,
    409: error(
      "CONFLICT: an account with this email already exists.",
      "CONFLICT",
      "An account with this email already exists",
    ),
  },
};

export const loginSchema = {
  operationId: "login",
  tags: ["Auth"],
  summary: "Sign in",
  description:
    "Starts a new session (sets the session cookie). A wrong password and an unknown email get the same 401. Needs the dashboard's Origin.",
  body: LoginBody,
  response: {
    200: meResponse("Signed in"),
    401: error(
      "UNAUTHORIZED: wrong email or password (always the same answer).",
      "UNAUTHORIZED",
      "Wrong email or password",
    ),
    ...authErrors,
  },
};

const OAuthProvider = Type.Enum(["google", "github"]);

export const oauthProvidersSchema = {
  operationId: "oauthProviders",
  tags: ["Auth"],
  summary: "The sign in providers that are set up",
  response: {
    200: {
      description: "Providers whose buttons the dashboard shows",
      content: {
        "application/json": {
          schema: Type.Object(
            { providers: Type.Array(OAuthProvider) },
            { additionalProperties: false },
          ),
        },
      },
    },
  },
};

const OAuthParams = Type.Object(
  { provider: OAuthProvider },
  { additionalProperties: false },
);
const redirect = (description: string) => ({ description, type: "null" });

export const oauthStartSchema = {
  operationId: "oauthStart",
  tags: ["Auth"],
  summary: "Continue with Google or GitHub",
  description:
    "A browser navigation, not a fetch: redirects to the provider with a state and a PKCE challenge, kept in a short signed cookie.",
  params: OAuthParams,
  response: {
    302: redirect("To the provider, or back to /login with oauth_error"),
  },
};

export const oauthCallbackSchema = {
  operationId: "oauthCallback",
  tags: ["Auth"],
  summary: "Where the provider sends the browser back",
  description:
    "Checks the state, exchanges the code (with the PKCE verifier) on the server, reads the provider's verified email, links or creates the account, starts a session and redirects to the dashboard. Failures redirect to /login?oauth_error=cancelled|failed|email_unverified|disabled|unavailable.",
  params: OAuthParams,
  querystring: Type.Object(
    {
      code: Type.Optional(Type.String({ maxLength: 2048 })),
      state: Type.Optional(Type.String({ maxLength: 256 })),
      error: Type.Optional(Type.String({ maxLength: 256 })),
    },
    { additionalProperties: true },
  ),
  response: { 302: redirect("To the dashboard") },
};

const noContent = (description: string) => ({ description, type: "null" });

export const logoutSchema = {
  operationId: "logout",
  tags: ["Auth"],
  summary: "Sign out of this session",
  security,
  response: { 204: noContent("Signed out"), 401: notSignedIn, ...authErrors },
};

export const logoutAllSchema = {
  operationId: "logoutAll",
  tags: ["Auth"],
  summary: "Sign out of every session",
  security,
  response: {
    204: noContent("Every session ended"),
    401: notSignedIn,
    ...authErrors,
  },
};

export const meSchema = {
  operationId: "me",
  tags: ["Auth"],
  summary: "The signed-in user and their workspaces",
  security,
  response: { 200: meResponse("You"), 401: notSignedIn },
};

export const changePasswordSchema = {
  operationId: "changePassword",
  tags: ["Auth"],
  summary: "Change your password",
  description: "Ends every other session; this one stays signed in.",
  security,
  body: ChangePasswordBody,
  response: {
    204: noContent("Changed"),
    401: error(
      "UNAUTHORIZED: not signed in, or the current password is wrong.",
      "UNAUTHORIZED",
      "The current password is wrong",
    ),
    ...authErrors,
  },
};

const conflict = (description: string, message: string) =>
  error(`CONFLICT: ${description}`, "CONFLICT", message);

export const WorkspaceName = Type.String({
  minLength: 1,
  maxLength: 100,
  pattern: "^[^\u0000-\u001f\u007f]+$",
});

export const ProfileBody = Type.Object(
  {
    displayName: Type.Union([
      Type.String({
        minLength: 1,
        maxLength: 60,
        pattern: "^[^\u0000-\u001f\u007f]+$",
      }),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);

export const updateProfileSchema = {
  operationId: "updateProfile",
  tags: ["Account"],
  summary: "Set or clear your display name",
  security,
  body: ProfileBody,
  response: { 200: meResponse("Saved"), 401: notSignedIn, ...authErrors },
};

const SessionInfo = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    createdAt: Type.String({ format: "date-time" }),
    lastUsedAt: Type.String({ format: "date-time" }),
    expiresAt: Type.String({ format: "date-time" }),
    ip: Type.String({ nullable: true }),
    userAgent: Type.String({ nullable: true }),
    current: Type.Boolean({ description: "This browser's session" }),
  },
  { additionalProperties: false },
);

export const listSessionsSchema = {
  operationId: "listSessions",
  tags: ["Account"],
  summary: "Your signed-in sessions",
  description: "Sessions that still work, most recently used first.",
  security,
  response: {
    200: {
      description: "Your sessions",
      content: {
        "application/json": {
          schema: Type.Object(
            { sessions: Type.Array(SessionInfo) },
            { additionalProperties: false },
          ),
        },
      },
    },
    401: notSignedIn,
  },
};

export const revokeSessionSchema = {
  operationId: "revokeSession",
  tags: ["Account"],
  summary: "End one of your sessions",
  description: "Ending this browser's own session signs it out.",
  security,
  params: Type.Object(
    { sessionId: Type.String({ pattern: UUID }) },
    { additionalProperties: false },
  ),
  response: {
    204: noContent("Ended"),
    401: notSignedIn,
    404: error(
      "NOT_FOUND: no such session of yours.",
      "NOT_FOUND",
      "Session not found",
    ),
    ...authErrors,
  },
};

export const DeleteAccountBody = Type.Object(
  {
    password: Type.Optional(Password),
    email: Type.Optional(Email),
  },
  { additionalProperties: false },
);

export const deleteAccountSchema = {
  operationId: "deleteAccount",
  tags: ["Account"],
  summary: "Delete your account",
  description:
    "Needs your password, or, for an account without one (Google or GitHub only), your email address typed again. Refused while you are the only owner of a workspace: delete it, or make someone else an owner, first. Your memberships and sessions end.",
  security,
  body: DeleteAccountBody,
  response: {
    204: noContent("Deleted and signed out"),
    401: error(
      "UNAUTHORIZED: not signed in, or the password is wrong.",
      "UNAUTHORIZED",
      "The password is wrong",
    ),
    409: conflict(
      "you are the only owner of a workspace.",
      "You are the only owner of Acme",
    ),
    ...authErrors,
  },
};

export const CreateWorkspaceBody = Type.Object(
  { name: WorkspaceName },
  { additionalProperties: false },
);

export const createWorkspaceSchema = {
  operationId: "createWorkspace",
  tags: ["Account"],
  summary: "Create a workspace",
  description: "You become its owner. At most 20 workspaces you own.",
  security,
  body: CreateWorkspaceBody,
  response: {
    201: {
      description: "Created",
      content: { "application/json": { schema: WorkspaceSummary } },
    },
    401: notSignedIn,
    409: conflict(
      "you already own the maximum number of workspaces.",
      "You can own at most 20 workspaces",
    ),
    ...authErrors,
  },
};

export const csrfSchema = {
  operationId: "csrfToken",
  tags: ["Auth"],
  summary: "A CSRF token for this session",
  description:
    "Send it in the X-CSRF-Token header of every request that changes something (POST, PUT, DELETE), file uploads included.",
  security,
  response: {
    200: {
      description: "The token",
      content: {
        "application/json": {
          schema: Type.Object(
            { csrfToken: Type.String() },
            { additionalProperties: false },
          ),
        },
      },
    },
    401: notSignedIn,
  },
};

export const WorkspaceParams = Type.Object({
  workspaceId: Type.String({ pattern: UUID }),
});

const workspaceNotFound = error(
  "NOT_FOUND: no such workspace, or you aren't a member (the same answer).",
  "NOT_FOUND",
  "Workspace not found",
);
const workspaceDeleting = error(
  "CONFLICT: the workspace is being deleted (crypto-shredded). Only finishing the deletion is possible.",
  "CONFLICT",
  "This workspace is being deleted",
);
const ownersOnly = error(
  "FORBIDDEN: only workspace owners can do this (or a CSRF/Origin problem).",
  "FORBIDDEN",
  "Only workspace owners can do this",
);

interface PublicRoute {
  params?: TObject;
  querystring?: TObject;
  headers?: TObject;
  body?: unknown;
  response: Record<number, unknown>;
  description?: string;
}

function fromPublic(
  base: PublicRoute,
  route: { operationId: string; tag: string; summary: string; owner?: boolean },
) {
  const properties: TProperties = {
    ...WorkspaceParams.properties,
    ...(base.params?.properties ?? {}),
  };
  return {
    ...base,
    operationId: route.operationId,
    tags: [route.tag],
    summary: route.summary + (route.owner ? " (owners only)" : ""),
    security,
    params: Type.Object(properties),
    response: {
      ...base.response,
      401: notSignedIn,
      ...(route.owner ? { 403: ownersOnly } : {}),
      404: workspaceNotFound,
      409: workspaceDeleting,
    },
  };
}

const Overview = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    name: Type.String(),
    role: Type.Enum(["owner", "member"]),
    secretsCount: Type.Integer({
      nullable: true,
      description: "null while the secrets service is sealed or unreachable",
    }),
    fileCount: Type.Integer({ nullable: true }),
    storage: Type.Object(
      {
        usedBytes: Type.Integer(),
        reservedBytes: Type.Integer(),
        limitBytes: Type.Integer(),
      },
      { additionalProperties: false, nullable: true },
    ),
    secretsSealed: Type.Boolean({
      nullable: true,
      description: "null if the secrets service can't be reached",
    }),
  },
  { additionalProperties: false },
);

export const overviewSchema = {
  operationId: "workspaceOverview",
  tags: ["Workspaces"],
  summary: "The workspace at a glance",
  security,
  params: WorkspaceParams,
  response: {
    200: {
      description: "Overview",
      content: { "application/json": { schema: Overview } },
    },
    401: notSignedIn,
    404: workspaceNotFound,
    409: workspaceDeleting,
  },
};

const count = Type.Integer({ minimum: 0 });
const Totals = Type.Object(
  {
    succeeded: Type.Integer({
      minimum: 0,
      description: "Calls through connections the outside API answered",
    }),
    refused: Type.Integer({
      minimum: 0,
      description: "Calls the gateway refused (policy or target rules)",
    }),
    failed: Type.Integer({
      minimum: 0,
      description: "Calls whose outside API couldn't be reached or failed",
    }),
    filesUploaded: count,
    filesDownloaded: count,
    changes: Type.Integer({
      minimum: 0,
      description:
        "Secrets, API keys, connections and files created, changed or removed",
    }),
    signIns: count,
    failedSignIns: count,
  },
  { additionalProperties: false },
);
const Day = Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" });
const Analytics = Type.Object(
  {
    range: Type.Enum(["7d", "30d", "90d"]),
    firstDay: Day,
    lastDay: Day,
    daily: Type.Array(
      Type.Object(
        { day: Day, ...Totals.properties },
        { additionalProperties: false },
      ),
      { description: "One entry per UTC day, oldest first, zeros included" },
    ),
    totals: Totals,
    previous: Type.Object(Totals.properties, {
      additionalProperties: false,
      description: "The same totals for the period just before",
    }),
    connections: Type.Array(
      Type.Object(
        {
          name: Type.String(),
          succeeded: count,
          refused: count,
          failed: count,
        },
        { additionalProperties: false },
      ),
      { description: "The busiest connections (at most 5), busiest first" },
    ),
  },
  { additionalProperties: false },
);

export const analyticsSchema = {
  operationId: "workspaceAnalytics",
  tags: ["Workspaces"],
  summary: "Activity in the workspace over the last 7, 30 or 90 days",
  description:
    "Counts from the workspace's own audit log, per UTC day: calls through connections (succeeded, refused, failed), file transfers, changes and sign-ins, with the previous period's totals and the busiest connections.",
  security,
  params: WorkspaceParams,
  querystring: Type.Object(
    {
      range: Type.Optional(Type.Enum(["7d", "30d", "90d"], { default: "7d" })),
    },
    { additionalProperties: false },
  ),
  response: {
    200: {
      description: "Analytics",
      content: { "application/json": { schema: Analytics } },
    },
    400: error("BAD_REQUEST: invalid range.", "BAD_REQUEST", "Invalid range"),
    401: notSignedIn,
    404: workspaceNotFound,
    409: workspaceDeleting,
    502: error(
      "UPSTREAM_UNAVAILABLE: the audit service can't be reached.",
      "UPSTREAM_UNAVAILABLE",
      "Audit service is unavailable",
    ),
  },
};

export const leaveWorkspaceSchema = {
  operationId: "leaveWorkspace",
  tags: ["Workspaces"],
  summary: "Leave the workspace",
  description:
    "Removes your own membership. The workspace's only owner can't leave (delete the workspace instead).",
  security,
  params: WorkspaceParams,
  response: {
    204: noContent("Left"),
    401: notSignedIn,
    404: workspaceNotFound,
    409: error(
      "CONFLICT: you are its only owner, or the workspace is being deleted.",
      "CONFLICT",
      "You are this workspace's only owner",
    ),
    ...authErrors,
  },
};

export const deleteWorkspaceSchema = {
  operationId: "deleteWorkspace",
  tags: ["Workspaces"],
  summary: "Delete the workspace for good (owners only)",
  description: [
    "Crypto-shreds the workspace: its API keys stop working, its key in the secrets service is destroyed (so every secret and every file key of the workspace can never be decrypted again, even from a copy), then its files, connections and memberships are removed. Not undoable.",
    "",
    'Confirm by sending the workspace\'s exact name. If a step fails part-way, the workspace stays "being deleted" (other routes answer 409) and sending this request again finishes it.',
  ].join("\n"),
  security,
  params: WorkspaceParams,
  body: Type.Object(
    {
      confirmName: Type.String({
        minLength: 1,
        maxLength: 200,
        description: "The workspace's exact name",
      }),
    },
    { additionalProperties: false },
  ),
  response: {
    204: noContent("Deleted"),
    400: error(
      "BAD_REQUEST: invalid input, or confirmName isn't the workspace's name.",
      "BAD_REQUEST",
      "Type the workspace's exact name to confirm",
    ),
    401: notSignedIn,
    403: ownersOnly,
    404: workspaceNotFound,
    502: error(
      "UPSTREAM_UNAVAILABLE: an internal service couldn't finish its part. The workspace is being deleted: send the request again.",
      "UPSTREAM_UNAVAILABLE",
      "The deletion didn't finish: try again",
    ),
    503: error(
      "SECRETS_SEALED: the secrets service is sealed, so its key can't be destroyed yet (nothing was changed). SERVICE_UNAVAILABLE: the audit log can't record the deletion (nothing was changed).",
      "SECRETS_SEALED",
      "The secrets service is sealed until an operator unseals it",
    ),
  },
};

const ApiKey = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    name: Type.String(),
    prefix: Type.String({ description: "The non-secret start of the key" }),
    status: Type.Enum(["active", "revoked"]),
    createdAt: Type.String({ format: "date-time" }),
    revokedAt: Type.String({ format: "date-time", nullable: true }),
    lastUsedAt: Type.String({ format: "date-time", nullable: true }),
  },
  { additionalProperties: false },
);
export const KeyParams = Type.Object({
  workspaceId: Type.String({ pattern: UUID }),
  keyId: Type.String({ pattern: UUID }),
});
export const NewKeyBody = Type.Object(
  { name: Type.String({ minLength: 1, maxLength: 100 }) },
  { additionalProperties: false },
);

export const listKeysSchema = {
  operationId: "listApiKeys",
  tags: ["API keys"],
  summary: "List the workspace's API keys (never the keys themselves)",
  security,
  params: WorkspaceParams,
  response: {
    200: {
      description: "Keys",
      content: {
        "application/json": {
          schema: Type.Object(
            { apiKeys: Type.Array(ApiKey) },
            { additionalProperties: false },
          ),
        },
      },
    },
    401: notSignedIn,
    404: workspaceNotFound,
  },
};

export const createKeySchema = {
  operationId: "createApiKey",
  tags: ["API keys"],
  summary: "Create an API key (owners only)",
  description:
    "The full key is in this response ONLY; it can never be shown again.",
  security,
  params: WorkspaceParams,
  body: NewKeyBody,
  response: {
    201: {
      description: "Created",
      content: {
        "application/json": {
          schema: Type.Object(
            { apiKey: ApiKey, key: Type.String(), warning: Type.String() },
            { additionalProperties: false },
          ),
        },
      },
    },
    ...authErrors,
    401: notSignedIn,
    403: ownersOnly,
    404: workspaceNotFound,
  },
};

export const revokeKeySchema = {
  operationId: "revokeApiKey",
  tags: ["API keys"],
  summary: "Revoke an API key (owners only)",
  security,
  params: KeyParams,
  response: {
    204: noContent("Revoked"),
    ...authErrors,
    401: notSignedIn,
    403: ownersOnly,
    404: error(
      "NOT_FOUND: no such workspace or key.",
      "NOT_FOUND",
      "API key not found",
    ),
  },
};

export const listSecretsDashboardSchema = fromPublic(listSecretsSchema, {
  operationId: "listSecrets",
  tag: "Secrets",
  summary: "List secrets (names and metadata, never values)",
});
export const putSecretDashboardSchema = fromPublic(putSecretSchema, {
  operationId: "putSecret",
  tag: "Secrets",
  summary: "Create a secret, or save a new version",
  owner: true,
});
export const rotateSecretDashboardSchema = fromPublic(rotateSecretSchema, {
  operationId: "rotateSecret",
  tag: "Secrets",
  summary: "Rotate an existing secret",
  owner: true,
});
export const deleteSecretDashboardSchema = fromPublic(deleteSecretSchema, {
  operationId: "deleteSecret",
  tag: "Secrets",
  summary: "Delete a secret and every version",
  owner: true,
});
export const listVersionsDashboardSchema = fromPublic(listVersionsSchema, {
  operationId: "listSecretVersions",
  tag: "Secrets",
  summary: "A secret's versions (metadata only)",
});

export const listFilesDashboardSchema = fromPublic(listFilesSchema, {
  operationId: "listFiles",
  tag: "Files",
  summary: "List files",
});
export const uploadFileDashboardSchema = fromPublic(uploadFileSchema, {
  operationId: "uploadFile",
  tag: "Files",
  summary: "Upload a file (the body is the file)",
});
export const downloadFileDashboardSchema = fromPublic(downloadFileSchema, {
  operationId: "downloadFile",
  tag: "Files",
  summary: "Download a file",
});
export const fileMetadataDashboardSchema = fromPublic(fileMetadataSchema, {
  operationId: "fileMetadata",
  tag: "Files",
  summary: "A file's metadata",
});
export const deleteFileDashboardSchema = fromPublic(deleteFileSchema, {
  operationId: "deleteFile",
  tag: "Files",
  summary: "Delete a file",
  owner: true,
});
export const usageDashboardSchema = fromPublic(usageSchema, {
  operationId: "storageUsage",
  tag: "Files",
  summary: "Storage used and allowed",
});

export const listConnectionsDashboardSchema = fromPublic(
  listConnectionsSchema,
  {
    operationId: "listConnections",
    tag: "Proxy connections",
    summary: "List proxy connections",
  },
);
export const putConnectionDashboardSchema = fromPublic(putConnectionSchema, {
  operationId: "putConnection",
  tag: "Proxy connections",
  summary: "Create or update a proxy connection",
  owner: true,
});
export const connectionUsageDashboardSchema = fromPublic(
  connectionUsageSchema,
  {
    operationId: "connectionUsage",
    tag: "Proxy connections",
    summary: "A connection's usage against its policy",
  },
);
export const deleteConnectionDashboardSchema = fromPublic(
  deleteConnectionSchema,
  {
    operationId: "deleteConnection",
    tag: "Proxy connections",
    summary: "Delete a proxy connection",
    owner: true,
  },
);

export const listAuditDashboardSchema = fromPublic(listAuditEventsSchema, {
  operationId: "listAuditEvents",
  tag: "Audit",
  summary: "This workspace's audit events",
});

const PoolSettings = {
  accessTokenTtlSeconds: Type.Integer({
    minimum: 60,
    maximum: 86_400,
    description: "How long access tokens work (default 900)",
  }),
  refreshTokenTtlSeconds: Type.Integer({
    minimum: 3_600,
    maximum: 90 * 86_400,
    description: "How long a sign-in lasts (default 30 days)",
  }),
  minPasswordLength: Type.Integer({
    minimum: 12,
    maximum: 64,
    description: "The users' minimum password length (default 12)",
  }),
};
const PoolNameSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$",
});
const PoolSchema = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    name: Type.String(),
    accessTokenTtlSeconds: Type.Integer(),
    refreshTokenTtlSeconds: Type.Integer(),
    minPasswordLength: Type.Integer(),
    userCount: Type.Integer({ minimum: 0 }),
    issuer: Type.String({ description: "The tokens' iss claim" }),
    jwksUrl: Type.String({ description: "Where apps get the public keys" }),
    createdAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);
const PoolUserSchema = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    email: Type.String(),
    status: Type.Enum(["active", "disabled"]),
    locked: Type.Boolean(),
    passwordResetRequired: Type.Boolean(),
    attributes: Type.Record(
      Type.String(),
      Type.Union([Type.String(), Type.Number(), Type.Boolean()]),
    ),
    roles: Type.Array(Type.String()),
    createdAt: Type.String({ format: "date-time" }),
    lastLoginAt: Type.String({ format: "date-time", nullable: true }),
  },
  { additionalProperties: false },
);
const PoolIdParams = Type.Object({
  workspaceId: Type.String({ pattern: UUID }),
  poolId: Type.String({ pattern: UUID }),
});
const PoolUserParams = Type.Object({
  workspaceId: Type.String({ pattern: UUID }),
  poolId: Type.String({ pattern: UUID }),
  userId: Type.String({ pattern: UUID }),
});
const json = (description: string, schema: object) => ({
  description,
  content: { "application/json": { schema } },
});
const poolErrors = {
  400: error("BAD_REQUEST: invalid input.", "BAD_REQUEST", "Invalid input"),
  401: notSignedIn,
  404: error(
    "NOT_FOUND: no such workspace, pool or user (or you aren't a member).",
    "NOT_FOUND",
    "User pool not found",
  ),
  409: workspaceDeleting,
  502: error(
    "UPSTREAM_UNAVAILABLE: the identity service can't be reached.",
    "UPSTREAM_UNAVAILABLE",
    "Identity service is unavailable",
  ),
  503: error(
    "SECRETS_SEALED: creating a pool needs the vault unsealed. SERVICE_UNAVAILABLE: the audit log is unavailable (changes are refused).",
    "SECRETS_SEALED",
    "The secrets service is sealed until an operator unseals it",
  ),
};
const poolRoute = <T extends object>(
  operationId: string,
  summary: string,
  owner: boolean,
  extra: T,
) => ({
  operationId,
  tags: ["User pools"],
  summary: summary + (owner ? " (owners only)" : ""),
  security,
  ...extra,
});
const ownerErrors = { ...poolErrors, 403: ownersOnly };

export const listPoolsSchema = poolRoute(
  "listUserPools",
  "The workspace's user pools",
  false,
  {
    params: WorkspaceParams,
    response: {
      200: json(
        "User pools",
        Type.Object(
          { pools: Type.Array(PoolSchema) },
          { additionalProperties: false },
        ),
      ),
      ...poolErrors,
    },
  },
);
export const createPoolSchema = poolRoute(
  "createUserPool",
  "Create a user pool",
  true,
  {
    params: WorkspaceParams,
    body: Type.Object(
      {
        name: PoolNameSchema,
        accessTokenTtlSeconds: Type.Optional(
          PoolSettings.accessTokenTtlSeconds,
        ),
        refreshTokenTtlSeconds: Type.Optional(
          PoolSettings.refreshTokenTtlSeconds,
        ),
        minPasswordLength: Type.Optional(PoolSettings.minPasswordLength),
      },
      { additionalProperties: false },
    ),
    response: {
      201: json("The new pool", PoolSchema),
      ...ownerErrors,
      409: error(
        "CONFLICT: a pool with this name exists, or the workspace is being deleted.",
        "CONFLICT",
        "A user pool with this name already exists",
      ),
    },
  },
);
export const getPoolSchema = poolRoute("getUserPool", "A user pool", false, {
  params: PoolIdParams,
  response: { 200: json("The pool", PoolSchema), ...poolErrors },
});
export const updatePoolSchema = poolRoute(
  "updateUserPool",
  "Rename a pool or change its settings",
  true,
  {
    params: PoolIdParams,
    body: Type.Object(
      {
        name: Type.Optional(PoolNameSchema),
        accessTokenTtlSeconds: Type.Optional(
          PoolSettings.accessTokenTtlSeconds,
        ),
        refreshTokenTtlSeconds: Type.Optional(
          PoolSettings.refreshTokenTtlSeconds,
        ),
        minPasswordLength: Type.Optional(PoolSettings.minPasswordLength),
      },
      { additionalProperties: false, minProperties: 1 },
    ),
    response: {
      200: json("The pool", PoolSchema),
      ...ownerErrors,
      409: error(
        "CONFLICT: a pool with this name exists, or the workspace is being deleted.",
        "CONFLICT",
        "A user pool with this name already exists",
      ),
    },
  },
);
export const deletePoolSchema = poolRoute(
  "deleteUserPool",
  "Delete a pool, its key, users and sessions",
  true,
  {
    params: PoolIdParams,
    response: { 204: { description: "Deleted" }, ...ownerErrors },
  },
);
export const listPoolUsersSchema = poolRoute(
  "listPoolUsers",
  "A pool's users, newest first",
  false,
  {
    params: PoolIdParams,
    querystring: Type.Object({
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 100, default: 50 }),
      ),
      cursor: Type.Optional(Type.String({ pattern: UUID })),
      email: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 254,
          description: "Only emails containing this",
        }),
      ),
    }),
    response: {
      200: json(
        "One page of users",
        Type.Object(
          {
            users: Type.Array(PoolUserSchema),
            nextCursor: Type.String({ nullable: true }),
          },
          { additionalProperties: false },
        ),
      ),
      ...poolErrors,
    },
  },
);
export const getPoolUserDashboardSchema = poolRoute(
  "getPoolUserDashboard",
  "A pool user",
  false,
  {
    params: PoolUserParams,
    response: { 200: json("The user", PoolUserSchema), ...poolErrors },
  },
);
export const updatePoolUserSchema = poolRoute(
  "updatePoolUser",
  "Enable or disable a user (disabling ends their sessions)",
  true,
  {
    params: PoolUserParams,
    body: Type.Object(
      { status: Type.Enum(["active", "disabled"]) },
      { additionalProperties: false },
    ),
    response: { 200: json("The user", PoolUserSchema), ...ownerErrors },
  },
);
export const deletePoolUserSchema = poolRoute(
  "deletePoolUser",
  "Delete a user and their sessions",
  true,
  {
    params: PoolUserParams,
    response: { 204: { description: "Deleted" }, ...ownerErrors },
  },
);
export const resetPoolUserPasswordSchema = poolRoute(
  "resetPoolUserPassword",
  "Require a password reset: the user's sessions end and their next sign-in asks them to choose a new password",
  true,
  {
    params: PoolUserParams,
    response: {
      200: json("The user, with passwordResetRequired", PoolUserSchema),
      ...ownerErrors,
    },
  },
);

export const unlockPoolUserSchema = poolRoute(
  "unlockPoolUser",
  "Unlock a user locked after repeated wrong passwords",
  true,
  {
    params: PoolUserParams,
    response: {
      200: json("The user, no longer locked", PoolUserSchema),
      ...ownerErrors,
    },
  },
);

export const listPoolAuditEventsSchema = poolRoute(
  "listPoolAuditEvents",
  "A user pool's own audit log, newest first (separate from the workspace's)",
  false,
  {
    params: PoolIdParams,
    querystring: PoolAuditEventsQuery,
    response: { 200: json("One page of events", PoolAuditPage), ...poolErrors },
  },
);

const FlagSchema = Type.Object(
  {
    key: Type.String(),
    description: Type.String(),
    kind: Type.Enum(["boolean", "string"]),
    offValue: FlagValue,
    environments: Type.Object(
      {
        development: FlagEnvironmentSettings,
        staging: FlagEnvironmentSettings,
        production: FlagEnvironmentSettings,
      },
      { additionalProperties: false },
    ),
    createdAt: Type.String({ format: "date-time" }),
    updatedAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);
const FlagParams = Type.Object({
  workspaceId: Type.String({ pattern: UUID }),
  key: Type.String({ pattern: FLAG_KEY }),
});
const flagErrors = {
  400: error(
    "BAD_REQUEST: invalid input, or a value of the wrong kind.",
    "BAD_REQUEST",
    "Invalid input",
  ),
  401: notSignedIn,
  404: error(
    "NOT_FOUND: no such workspace or flag.",
    "NOT_FOUND",
    "Flag not found",
  ),
  409: workspaceDeleting,
  502: error(
    "UPSTREAM_UNAVAILABLE: the flags service can't be reached.",
    "UPSTREAM_UNAVAILABLE",
    "Flags service is unavailable",
  ),
  503: error(
    "SERVICE_UNAVAILABLE: the audit log is unavailable (changes are refused).",
    "SERVICE_UNAVAILABLE",
    "Service temporarily unavailable",
  ),
};
const flagOwnerErrors = { ...flagErrors, 403: ownersOnly };
const flagRoute = <T extends object>(
  operationId: string,
  summary: string,
  owner: boolean,
  extra: T,
) => ({
  operationId,
  tags: ["Feature flags"],
  summary: summary + (owner ? " (owners only)" : ""),
  security,
  ...extra,
});

export const listFlagsSchema = flagRoute(
  "listFlags",
  "The workspace's feature flags",
  false,
  {
    params: WorkspaceParams,
    response: {
      200: json(
        "Flags",
        Type.Object(
          { flags: Type.Array(FlagSchema) },
          { additionalProperties: false },
        ),
      ),
      ...flagErrors,
    },
  },
);
export const createFlagSchema = flagRoute(
  "createFlag",
  "Create a flag (off everywhere)",
  true,
  {
    params: WorkspaceParams,
    body: Type.Object(
      {
        key: Type.String({ pattern: FLAG_KEY }),
        description: Type.Optional(Type.String({ maxLength: 500 })),
        kind: Type.Enum(["boolean", "string"]),
        offValue: FlagValue,
      },
      { additionalProperties: false },
    ),
    response: {
      201: json("The new flag", FlagSchema),
      ...flagOwnerErrors,
      409: error(
        "CONFLICT: the key is taken, or the workspace is being deleted.",
        "CONFLICT",
        "A flag with this key already exists",
      ),
    },
  },
);
export const getFlagSchema = flagRoute("getFlag", "A flag", false, {
  params: FlagParams,
  response: { 200: json("The flag", FlagSchema), ...flagErrors },
});
export const updateFlagSchema = flagRoute(
  "updateFlag",
  "Change a flag's description",
  true,
  {
    params: FlagParams,
    body: Type.Object(
      { description: Type.String({ maxLength: 500 }) },
      { additionalProperties: false },
    ),
    response: { 200: json("The flag", FlagSchema), ...flagOwnerErrors },
  },
);
export const setFlagEnvironmentSchema = flagRoute(
  "setFlagEnvironment",
  "Replace a flag's settings in one environment (on/off, rules, rollout, default)",
  true,
  {
    params: Type.Object({
      workspaceId: Type.String({ pattern: UUID }),
      key: Type.String({ pattern: FLAG_KEY }),
      environment: FlagEnvironment,
    }),
    body: FlagEnvironmentSettings,
    response: { 200: json("The flag", FlagSchema), ...flagOwnerErrors },
  },
);
export const deleteFlagSchema = flagRoute("deleteFlag", "Delete a flag", true, {
  params: FlagParams,
  response: { 204: { description: "Deleted" }, ...flagOwnerErrors },
});
export const testFlagsSchema = flagRoute(
  "testFlags",
  "See what the flags give one user (a test, like an app's call)",
  false,
  {
    params: WorkspaceParams,
    body: FlagEvaluateBody,
    response: { 200: json("The values", FlagEvaluation), ...flagErrors },
  },
);

const PoolRoleParams = Type.Object({
  workspaceId: Type.String({ pattern: UUID }),
  poolId: Type.String({ pattern: UUID }),
  role: PoolRoleName,
});
const PoolUserRoleParams = Type.Object({
  workspaceId: Type.String({ pattern: UUID }),
  poolId: Type.String({ pattern: UUID }),
  userId: Type.String({ pattern: UUID }),
  role: PoolRoleName,
});
const roleConflict = error(
  "CONFLICT: the role exists already, the pool or user has the most roles allowed, or the workspace is being deleted.",
  "CONFLICT",
  "A role with this name already exists",
);

export const listPoolRolesSchema = poolRoute(
  "listPoolRolesDashboard",
  "A pool's roles",
  false,
  {
    params: PoolIdParams,
    response: { 200: json("Roles", PoolRoleList), ...poolErrors },
  },
);
export const createPoolRoleSchema = poolRoute(
  "createPoolRoleDashboard",
  "Create a role",
  true,
  {
    params: PoolIdParams,
    body: PoolNewRoleBody,
    response: {
      201: json("The role", PoolRole),
      ...ownerErrors,
      409: roleConflict,
    },
  },
);
export const updatePoolRoleSchema = poolRoute(
  "updatePoolRoleDashboard",
  "Change a role's description or permissions",
  true,
  {
    params: PoolRoleParams,
    body: PoolRoleChangesBody,
    response: { 200: json("The role", PoolRole), ...ownerErrors },
  },
);
export const deletePoolRoleSchema = poolRoute(
  "deletePoolRoleDashboard",
  "Delete a role",
  true,
  {
    params: PoolRoleParams,
    response: { 204: { description: "Deleted" }, ...ownerErrors },
  },
);
export const addPoolUserRoleSchema = poolRoute(
  "addPoolUserRoleDashboard",
  "Give a user a role",
  true,
  {
    params: PoolUserRoleParams,
    response: {
      200: json("The user", PoolUserSchema),
      ...ownerErrors,
      409: roleConflict,
    },
  },
);
export const removePoolUserRoleSchema = poolRoute(
  "removePoolUserRoleDashboard",
  "Take a role from a user",
  true,
  {
    params: PoolUserRoleParams,
    response: { 200: json("The user", PoolUserSchema), ...ownerErrors },
  },
);

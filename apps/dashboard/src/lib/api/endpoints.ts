import { apiUrl } from "./origin";
import {
  API_BASE,
  type Analytics,
  type AnalyticsRange,
  clearCsrfToken,
  request,
  uploadFile,
  type ApiKeyList,
  type AuditList,
  type PoolAuditList,
  type ConnectionList,
  type ConnectionPolicy,
  type ConnectionUsage,
  type Flag,
  type FlagEnvironmentName,
  type FlagEvaluation,
  type FlagList,
  type FlagSettings,
  type Pool,
  type PoolList,
  type PoolRole,
  type PoolRoleList,
  type PoolUser,
  type PoolUserList,
  type FileList,
  type FileMetadata,
  type Me,
  type OAuthProvider,
  type SessionList,
  type WorkspaceSummary,
  type NewApiKey,
  type Overview,
  type SecretList,
  type SecretVersions,
  type Usage,
} from "./client";

export interface PoolSettings {
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
  minPasswordLength?: number;
}

const ws = (workspaceId: string, path = "") =>
  `${API_BASE}/workspaces/${encodeURIComponent(workspaceId)}${path}`;
const name = (value: string) => encodeURIComponent(value);

export const auth = {
  signUp: (body: { email: string; password: string; workspaceName: string }) =>
    request<Me>("POST", `${API_BASE}/auth/sign-up`, { json: body }).then(
      (me) => {
        clearCsrfToken();
        return me;
      },
    ),
  login: (body: { email: string; password: string }) =>
    request<Me>("POST", `${API_BASE}/auth/login`, { json: body }).then((me) => {
      clearCsrfToken();
      return me;
    }),
  oauthProviders: () =>
    request<{ providers: OAuthProvider[] }>(
      "GET",
      `${API_BASE}/auth/oauth/providers`,
    ),
  oauthStartUrl: (provider: OAuthProvider) =>
    apiUrl(`${API_BASE}/auth/oauth/${provider}/start`),
  me: () => request<Me>("GET", `${API_BASE}/auth/me`),
  logout: () =>
    request<void>("POST", `${API_BASE}/auth/logout`).finally(clearCsrfToken),
  logoutAll: () =>
    request<void>("POST", `${API_BASE}/auth/logout-all`).finally(
      clearCsrfToken,
    ),
  changePassword: (body: { currentPassword: string; newPassword: string }) =>
    request<void>("POST", `${API_BASE}/auth/change-password`, { json: body }),
};

export const account = {
  updateProfile: (displayName: string | null) =>
    request<Me>("PATCH", `${API_BASE}/account/profile`, {
      json: { displayName },
    }),
  sessions: () => request<SessionList>("GET", `${API_BASE}/account/sessions`),
  revokeSession: (sessionId: string) =>
    request<void>(
      "DELETE",
      `${API_BASE}/account/sessions/${encodeURIComponent(sessionId)}`,
    ),
  deleteAccount: (confirm: { password: string } | { email: string }) =>
    request<void>("POST", `${API_BASE}/account/delete`, {
      json: confirm,
    }).finally(clearCsrfToken),
  createWorkspace: (workspaceName: string) =>
    request<WorkspaceSummary>("POST", `${API_BASE}/workspaces`, {
      json: { name: workspaceName },
    }),
  leaveWorkspace: (id: string) =>
    request<void>("DELETE", ws(id, "/membership")),
};

export const workspace = {
  overview: (id: string) => request<Overview>("GET", ws(id)),
  analytics: (id: string, range: AnalyticsRange) =>
    request<Analytics>("GET", ws(id, "/analytics"), { query: { range } }),

  apiKeys: (id: string) => request<ApiKeyList>("GET", ws(id, "/api-keys")),
  createApiKey: (id: string, keyName: string) =>
    request<NewApiKey>("POST", ws(id, "/api-keys"), {
      json: { name: keyName },
    }),
  revokeApiKey: (id: string, keyId: string) =>
    request<void>("DELETE", ws(id, `/api-keys/${name(keyId)}`)),

  secrets: (id: string, cursor?: string) =>
    request<SecretList>("GET", ws(id, "/secrets"), {
      query: { limit: 50, cursor },
    }),
  saveSecret: (id: string, secretName: string, value: string) =>
    request<unknown>("PUT", ws(id, `/secrets/${name(secretName)}`), {
      json: { value },
    }),
  rotateSecret: (id: string, secretName: string, value: string) =>
    request<unknown>("POST", ws(id, `/secrets/${name(secretName)}/rotate`), {
      json: { value },
    }),
  deleteSecret: (id: string, secretName: string) =>
    request<void>("DELETE", ws(id, `/secrets/${name(secretName)}`)),
  secretVersions: (id: string, secretName: string) =>
    request<SecretVersions>(
      "GET",
      ws(id, `/secrets/${name(secretName)}/versions`),
      { query: { limit: 100 } },
    ),

  files: (id: string, cursor?: string) =>
    request<FileList>("GET", ws(id, "/files"), {
      query: { limit: 50, cursor },
    }),
  usage: (id: string) => request<Usage>("GET", ws(id, "/usage")),
  uploadFile: (
    id: string,
    file: File,
    onProgress: (fraction: number) => void,
  ) => uploadFile(ws(id, "/files"), file, onProgress),
  downloadUrl: (id: string, fileId: string) =>
    apiUrl(ws(id, `/files/${name(fileId)}`)),
  deleteFile: (id: string, fileId: string) =>
    request<void>("DELETE", ws(id, `/files/${name(fileId)}`)),

  connections: (id: string) =>
    request<ConnectionList>("GET", ws(id, "/proxy-connections")),
  saveConnection: (
    id: string,
    connectionName: string,
    body: {
      baseUrl: string;
      secretName: string;
      headerName: string;
      headerPrefix?: string;
      policy?: ConnectionPolicy;
    },
  ) =>
    request<unknown>(
      "PUT",
      ws(id, `/proxy-connections/${name(connectionName)}`),
      { json: body },
    ),
  connectionUsage: (id: string, connectionName: string) =>
    request<ConnectionUsage>(
      "GET",
      ws(id, `/proxy-connections/${name(connectionName)}/usage`),
    ),
  deleteWorkspace: (id: string, confirmName: string) =>
    request<void>("DELETE", ws(id, ""), { json: { confirmName } }),
  deleteConnection: (id: string, connectionName: string) =>
    request<void>(
      "DELETE",
      ws(id, `/proxy-connections/${name(connectionName)}`),
    ),

  pools: (id: string) => request<PoolList>("GET", ws(id, "/user-pools")),
  pool: (id: string, poolId: string) =>
    request<Pool>("GET", ws(id, `/user-pools/${name(poolId)}`)),
  createPool: (id: string, body: PoolSettings & { name: string }) =>
    request<Pool>("POST", ws(id, "/user-pools"), { json: body }),
  updatePool: (
    id: string,
    poolId: string,
    body: Partial<PoolSettings & { name: string }>,
  ) =>
    request<Pool>("PATCH", ws(id, `/user-pools/${name(poolId)}`), {
      json: body,
    }),
  deletePool: (id: string, poolId: string) =>
    request<void>("DELETE", ws(id, `/user-pools/${name(poolId)}`)),
  poolUsers: (
    id: string,
    poolId: string,
    query: { cursor?: string; email?: string },
  ) =>
    request<PoolUserList>("GET", ws(id, `/user-pools/${name(poolId)}/users`), {
      query: { limit: 25, ...query },
    }),
  setPoolUserStatus: (
    id: string,
    poolId: string,
    userId: string,
    status: "active" | "disabled",
  ) =>
    request<PoolUser>(
      "PATCH",
      ws(id, `/user-pools/${name(poolId)}/users/${name(userId)}`),
      { json: { status } },
    ),
  poolRoles: (id: string, poolId: string) =>
    request<PoolRoleList>("GET", ws(id, `/user-pools/${name(poolId)}/roles`)),
  createPoolRole: (
    id: string,
    poolId: string,
    body: { name: string; description: string; permissions: string[] },
  ) =>
    request<PoolRole>("POST", ws(id, `/user-pools/${name(poolId)}/roles`), {
      json: body,
    }),
  updatePoolRole: (
    id: string,
    poolId: string,
    role: string,
    body: { description: string; permissions: string[] },
  ) =>
    request<PoolRole>(
      "PATCH",
      ws(id, `/user-pools/${name(poolId)}/roles/${name(role)}`),
      { json: body },
    ),
  deletePoolRole: (id: string, poolId: string, role: string) =>
    request<void>(
      "DELETE",
      ws(id, `/user-pools/${name(poolId)}/roles/${name(role)}`),
    ),
  addPoolUserRole: (id: string, poolId: string, userId: string, role: string) =>
    request<PoolUser>(
      "PUT",
      ws(
        id,
        `/user-pools/${name(poolId)}/users/${name(userId)}/roles/${name(role)}`,
      ),
    ),
  removePoolUserRole: (
    id: string,
    poolId: string,
    userId: string,
    role: string,
  ) =>
    request<PoolUser>(
      "DELETE",
      ws(
        id,
        `/user-pools/${name(poolId)}/users/${name(userId)}/roles/${name(role)}`,
      ),
    ),
  poolUser: (id: string, poolId: string, userId: string) =>
    request<PoolUser>(
      "GET",
      ws(id, `/user-pools/${name(poolId)}/users/${name(userId)}`),
    ),
  fileMetadata: (id: string, fileId: string) =>
    request<FileMetadata>("GET", ws(id, `/files/${name(fileId)}/metadata`)),
  deletePoolUser: (id: string, poolId: string, userId: string) =>
    request<void>(
      "DELETE",
      ws(id, `/user-pools/${name(poolId)}/users/${name(userId)}`),
    ),
  resetPoolUserPassword: (id: string, poolId: string, userId: string) =>
    request<PoolUser>(
      "POST",
      ws(
        id,
        `/user-pools/${name(poolId)}/users/${name(userId)}/reset-password`,
      ),
    ),
  unlockPoolUser: (id: string, poolId: string, userId: string) =>
    request<PoolUser>(
      "POST",
      ws(id, `/user-pools/${name(poolId)}/users/${name(userId)}/unlock`),
    ),
  poolAuditEvents: (
    id: string,
    poolId: string,
    query: Record<string, string | number | undefined>,
  ) =>
    request<PoolAuditList>(
      "GET",
      ws(id, `/user-pools/${name(poolId)}/audit-events`),
      { query },
    ),

  flags: (id: string) => request<FlagList>("GET", ws(id, "/flags")),
  flag: (id: string, key: string) =>
    request<Flag>("GET", ws(id, `/flags/${name(key)}`)),
  createFlag: (
    id: string,
    body: {
      key: string;
      description?: string;
      kind: "boolean" | "string";
      offValue: boolean | string;
    },
  ) => request<Flag>("POST", ws(id, "/flags"), { json: body }),
  setFlagEnvironment: (
    id: string,
    key: string,
    environment: FlagEnvironmentName,
    settings: FlagSettings,
  ) =>
    request<Flag>(
      "PUT",
      ws(id, `/flags/${name(key)}/environments/${environment}`),
      { json: settings },
    ),
  deleteFlag: (id: string, key: string) =>
    request<void>("DELETE", ws(id, `/flags/${name(key)}`)),
  testFlags: (
    id: string,
    body: {
      environment: FlagEnvironmentName;
      context: {
        key: string;
        attributes?: Record<string, string | number | boolean>;
      };
      keys?: string[];
    },
  ) =>
    request<FlagEvaluation>("POST", ws(id, "/flags/evaluate"), { json: body }),

  auditEvents: (
    id: string,
    query: Record<string, string | number | undefined>,
  ) => request<AuditList>("GET", ws(id, "/audit-events"), { query }),
};

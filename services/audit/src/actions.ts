export const SERVICES = [
  "gateway",
  "secrets",
  "storage",
  "identity",
  "flags",
] as const;
export type ServiceName = (typeof SERVICES)[number];

export interface ActionRule {
  resourceType: string;
  chain: "tenant" | "platform" | "tenant-or-platform";
  sentBy: ServiceName;
}

export const ACTIONS = {
  "tenant.created": {
    resourceType: "tenant",
    chain: "tenant",
    sentBy: "gateway",
  },
  "tenant.suspended": {
    resourceType: "tenant",
    chain: "tenant",
    sentBy: "gateway",
  },
  "tenant.shredded": {
    resourceType: "tenant",
    chain: "platform",
    sentBy: "gateway",
  },
  "api_key.created": {
    resourceType: "api_key",
    chain: "tenant",
    sentBy: "gateway",
  },
  "api_key.revoked": {
    resourceType: "api_key",
    chain: "tenant",
    sentBy: "gateway",
  },
  "proxy_connection.created": {
    resourceType: "proxy_connection",
    chain: "tenant",
    sentBy: "gateway",
  },
  "proxy_connection.updated": {
    resourceType: "proxy_connection",
    chain: "tenant",
    sentBy: "gateway",
  },
  "proxy_connection.deleted": {
    resourceType: "proxy_connection",
    chain: "tenant",
    sentBy: "gateway",
  },
  "proxy_connection.used": {
    resourceType: "proxy_connection",
    chain: "tenant",
    sentBy: "gateway",
  },
  "proxy_connection.denied": {
    resourceType: "proxy_connection",
    chain: "tenant",
    sentBy: "gateway",
  },
  "secret.created": {
    resourceType: "secret",
    chain: "tenant",
    sentBy: "secrets",
  },
  "secret.read": { resourceType: "secret", chain: "tenant", sentBy: "secrets" },
  "secret.rotated": {
    resourceType: "secret",
    chain: "tenant",
    sentBy: "secrets",
  },
  "secret.deleted": {
    resourceType: "secret",
    chain: "tenant",
    sentBy: "secrets",
  },
  "secrets.initialised": {
    resourceType: "secrets_service",
    chain: "platform",
    sentBy: "secrets",
  },
  "secrets.unsealed": {
    resourceType: "secrets_service",
    chain: "platform",
    sentBy: "secrets",
  },
  "secrets.sealed": {
    resourceType: "secrets_service",
    chain: "platform",
    sentBy: "secrets",
  },
  "file.uploaded": { resourceType: "file", chain: "tenant", sentBy: "storage" },
  "file.downloaded": {
    resourceType: "file",
    chain: "tenant",
    sentBy: "storage",
  },
  "file.deleted": { resourceType: "file", chain: "tenant", sentBy: "storage" },
  "file.access_denied": {
    resourceType: "file",
    chain: "platform",
    sentBy: "storage",
  },
  "user.signed_up": {
    resourceType: "user",
    chain: "tenant",
    sentBy: "gateway",
  },
  "user.logged_in": {
    resourceType: "user",
    chain: "tenant",
    sentBy: "gateway",
  },
  "user.login_failed": {
    resourceType: "user",
    chain: "tenant-or-platform",
    sentBy: "gateway",
  },
  "user.logged_out": {
    resourceType: "user",
    chain: "tenant",
    sentBy: "gateway",
  },
  "user.password_changed": {
    resourceType: "user",
    chain: "tenant",
    sentBy: "gateway",
  },
  "membership.added": {
    resourceType: "membership",
    chain: "tenant",
    sentBy: "gateway",
  },
  "membership.removed": {
    resourceType: "membership",
    chain: "tenant",
    sentBy: "gateway",
  },
  "user.profile_updated": {
    resourceType: "user",
    chain: "tenant",
    sentBy: "gateway",
  },
  "user.session_revoked": {
    resourceType: "user",
    chain: "tenant",
    sentBy: "gateway",
  },
  "user.deleted": {
    resourceType: "user",
    chain: "tenant",
    sentBy: "gateway",
  },
  "user_pool.created": {
    resourceType: "user_pool",
    chain: "tenant",
    sentBy: "identity",
  },
  "user_pool.updated": {
    resourceType: "user_pool",
    chain: "tenant",
    sentBy: "identity",
  },
  "user_pool.deleted": {
    resourceType: "user_pool",
    chain: "tenant",
    sentBy: "identity",
  },
  "pool_user.signed_up": {
    resourceType: "pool_user",
    chain: "tenant",
    sentBy: "identity",
  },
  "pool_user.updated": {
    resourceType: "pool_user",
    chain: "tenant",
    sentBy: "identity",
  },
  "pool_user.deleted": {
    resourceType: "pool_user",
    chain: "tenant",
    sentBy: "identity",
  },
  "pool_user.password_reset": {
    resourceType: "pool_user",
    chain: "tenant",
    sentBy: "identity",
  },
  "pool_user.password_changed": {
    resourceType: "pool_user",
    chain: "tenant",
    sentBy: "identity",
  },
  "pool_user.logged_in": {
    resourceType: "pool_user",
    chain: "tenant",
    sentBy: "identity",
  },
  "pool_user.login_failed": {
    resourceType: "pool_user",
    chain: "tenant",
    sentBy: "identity",
  },
  "pool_user.logged_out": {
    resourceType: "pool_user",
    chain: "tenant",
    sentBy: "identity",
  },
  "pool_user.token_reused": {
    resourceType: "pool_user",
    chain: "tenant",
    sentBy: "identity",
  },
  "pool_role.created": {
    resourceType: "pool_role",
    chain: "tenant",
    sentBy: "identity",
  },
  "pool_role.updated": {
    resourceType: "pool_role",
    chain: "tenant",
    sentBy: "identity",
  },
  "pool_role.deleted": {
    resourceType: "pool_role",
    chain: "tenant",
    sentBy: "identity",
  },
  "pool_user.role_added": {
    resourceType: "pool_user",
    chain: "tenant",
    sentBy: "identity",
  },
  "pool_user.role_removed": {
    resourceType: "pool_user",
    chain: "tenant",
    sentBy: "identity",
  },
  "feature_flag.created": {
    resourceType: "feature_flag",
    chain: "tenant",
    sentBy: "flags",
  },
  "feature_flag.updated": {
    resourceType: "feature_flag",
    chain: "tenant",
    sentBy: "flags",
  },
  "feature_flag.toggled": {
    resourceType: "feature_flag",
    chain: "tenant",
    sentBy: "flags",
  },
  "feature_flag.deleted": {
    resourceType: "feature_flag",
    chain: "tenant",
    sentBy: "flags",
  },
  "secret.revealed": {
    resourceType: "secret",
    chain: "tenant",
    sentBy: "secrets",
  },
} as const satisfies Record<string, ActionRule>;

export type Action = keyof typeof ACTIONS;
export const ACTION_NAMES = Object.keys(ACTIONS) as Action[];
export const RESOURCE_TYPES = [
  ...new Set(Object.values(ACTIONS).map((rule) => rule.resourceType)),
];

export const ACTOR_TYPES = [
  "api_key",
  "user",
  "admin",
  "operator",
  "service",
] as const;
export const OUTCOMES = ["success", "denied", "failure"] as const;

export const PLATFORM_CHAIN = "platform";

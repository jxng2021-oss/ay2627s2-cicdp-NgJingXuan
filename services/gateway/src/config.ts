import type { ServerLimits } from "./app.js";
import { API_KEY_PREFIX_PATTERN } from "./services/api-key-tokens.service.js";
import type { RateLimitSettings } from "./limits.js";
import type { ProxyPolicy } from "./services/ssrf.service.js";

export interface GatewayConfig {
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  adminToken: string;
  apiKeyHashSecret: string;
  apiKeyPrefix: string;
  storageUrl: string;
  secretsUrl: string;
  identityUrl: string;
  flagsUrl: string;
  connectTimeoutMs: number;
  responseTimeoutMs: number;
  maxUploadBytes: number;
  maxSecretBytes: number;
  rateLimits: RateLimitSettings;
  server: ServerLimits;
  trustProxy: false | string[];
  apiDocsEnabled: boolean;
  proxy: ProxyPolicy;
  auditUrl: string;
  auditToken: string;
  auditTimeoutMs: number;
  version: string;
  adminApiEnabled: boolean;
  shutdownTimeoutMs: number;
}

const MIN_SECRET_LENGTH = 32;

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): GatewayConfig {
  const apiKeyPrefix = env.API_KEY_PREFIX ?? "sk_local_";
  if (!API_KEY_PREFIX_PATTERN.test(apiKeyPrefix)) {
    throw new Error("API_KEY_PREFIX must look like sk_<letters/digits>_");
  }
  const number = (name: string, fallback: number) =>
    positiveNumber(env, name, fallback);

  return {
    host: env.HOST ?? "0.0.0.0",
    port: number("GATEWAY_PORT", 8080),
    databaseUrl: required(env, "DATABASE_URL"),
    redisUrl: required(env, "REDIS_URL"),
    adminToken:
      env.ADMIN_API_ENABLED === "true"
        ? secret(env, "ADMIN_TOKEN")
        : (env.ADMIN_TOKEN ?? ""),
    apiKeyHashSecret: secret(env, "API_KEY_HASH_SECRET"),
    apiKeyPrefix,
    storageUrl: env.STORAGE_URL ?? "http://localhost:3001",
    secretsUrl: env.SECRETS_URL ?? "http://localhost:3002",
    identityUrl: env.IDENTITY_URL ?? "http://localhost:3004",
    flagsUrl: env.FLAGS_URL ?? "http://localhost:3005",
    connectTimeoutMs: number("UPSTREAM_CONNECT_TIMEOUT_MS", 5_000),
    responseTimeoutMs: number("UPSTREAM_RESPONSE_TIMEOUT_MS", 30_000),
    maxUploadBytes: number("MAX_UPLOAD_BYTES", 1024 * 1024 * 1024),
    maxSecretBytes: number("MAX_SECRET_BYTES", 64 * 1024),
    rateLimits: {
      windowMs: number("RATE_LIMIT_WINDOW_MS", 60_000),
      requestsPerKey: number("RATE_LIMIT_REQUESTS_PER_KEY", 600),
      uploadsPerKey: number("RATE_LIMIT_UPLOADS_PER_KEY", 60),
      failedAuthPerIp: number("RATE_LIMIT_FAILED_AUTH_PER_IP", 20),
      adminPerIp: number("RATE_LIMIT_ADMIN_PER_IP", 30),
    },
    server: {
      maxHeaderBytes: number("MAX_HEADER_BYTES", 16 * 1024),
      headersTimeoutMs: number("HEADERS_TIMEOUT_MS", 10_000),
      requestTimeoutMs: number("REQUEST_TIMEOUT_MS", 600_000),
      keepAliveTimeoutMs: number("KEEP_ALIVE_TIMEOUT_MS", 5_000),
      idleTimeoutMs: number("IDLE_TIMEOUT_MS", 60_000),
    },
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    apiDocsEnabled: env.API_DOCS_ENABLED === "true",
    proxy: parseProxyPolicy(env),
    auditUrl: env.AUDIT_URL ?? "http://localhost:3003",
    auditToken: secret(env, "AUDIT_TOKEN"),
    auditTimeoutMs: number("AUDIT_TIMEOUT_MS", 2_000),
    version: env.SERVICE_VERSION ?? "dev",
    adminApiEnabled: parseAdminApiEnabled(env),
    shutdownTimeoutMs: number("SHUTDOWN_TIMEOUT_MS", 25_000),
  };
}

export function parseProxyPolicy(env: NodeJS.ProcessEnv): ProxyPolicy {
  const allowedHosts = (env.PROXY_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  for (const host of allowedHosts) {
    if (!/^[a-z0-9.-]+$/.test(host)) {
      throw new Error(
        `PROXY_ALLOWED_HOSTS must list plain host names (like api.example.com), not "${host}"`,
      );
    }
  }
  const allowPrivateTargets = env.PROXY_ALLOW_PRIVATE_TARGETS === "true";
  if (allowPrivateTargets && env.NODE_ENV === "production") {
    throw new Error(
      "PROXY_ALLOW_PRIVATE_TARGETS=true is only for the local mock API and is refused when NODE_ENV=production",
    );
  }
  return { allowedHosts, allowPrivateTargets };
}

export function parseAdminApiEnabled(env: NodeJS.ProcessEnv): boolean {
  const enabled = env.ADMIN_API_ENABLED === "true";
  if (enabled && env.NODE_ENV === "production") {
    throw new Error(
      "ADMIN_API_ENABLED=true is only for local tests and is refused when NODE_ENV=production",
    );
  }
  return enabled;
}

export function parseTrustProxy(value: string | undefined): false | string[] {
  if (value === undefined || value.trim() === "" || value === "false")
    return false;
  if (value === "true") {
    throw new Error(
      "TRUST_PROXY=true would let any client fake its IP; list your proxies instead",
    );
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

function secret(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  if (value.length < MIN_SECRET_LENGTH) {
    throw new Error(`${name} must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  return value;
}

function positiveNumber(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

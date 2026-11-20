import type { ServiceName } from "./actions.js";

export interface AuditConfig {
  host: string;
  port: number;
  databaseUrl: string;
  hmacKey: string;
  serviceTokens: Record<ServiceName, string>;
  version: string;
  shutdownTimeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AuditConfig {
  const secret = (name: string) => {
    const value = env[name] ?? "";
    if (value.length < 32) {
      throw new Error(`${name} must be set, at least 32 characters`);
    }
    return value;
  };
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL must be set");
  const tokens = {
    gateway: secret("AUDIT_TOKEN_GATEWAY"),
    secrets: secret("AUDIT_TOKEN_SECRETS"),
    storage: secret("AUDIT_TOKEN_STORAGE"),
    identity: secret("AUDIT_TOKEN_IDENTITY"),
    flags: secret("AUDIT_TOKEN_FLAGS"),
  };
  if (new Set(Object.values(tokens)).size !== Object.keys(tokens).length) {
    throw new Error("Each service needs its own audit token");
  }
  return {
    host: env.HOST ?? "0.0.0.0",
    port: Number(env.AUDIT_PORT ?? 3003),
    databaseUrl,
    hmacKey: secret("AUDIT_HMAC_KEY"),
    serviceTokens: tokens,
    version: env.SERVICE_VERSION ?? "dev",
    shutdownTimeoutMs: Number(env.SHUTDOWN_TIMEOUT_MS ?? 25_000),
  };
}

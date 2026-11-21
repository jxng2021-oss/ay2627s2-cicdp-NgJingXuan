export interface IdentityConfig {
  host: string;
  port: number;
  databaseUrl: string;
  secretsUrl: string;
  identityServiceToken: string;
  auditUrl: string;
  auditToken: string;
  auditTimeoutMs: number;
  publicBaseUrl: string;
  version: string;
  requestTimeoutMs: number;
  shutdownTimeoutMs: number;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): IdentityConfig {
  const number = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive whole number`);
    }
    return value;
  };
  const token = (name: string): string => {
    const value = env[name] ?? "";
    if (value.length < 32) {
      throw new Error(`${name} must be set, at least 32 characters`);
    }
    return value;
  };
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL must be set");
  const publicBaseUrl = (
    env.PUBLIC_BASE_URL ?? "http://localhost:8080"
  ).replace(/\/$/, "");
  if (!/^https?:\/\/[^/?#]+$/.test(publicBaseUrl)) {
    throw new Error(
      "PUBLIC_BASE_URL must be an origin like https://api.example.com",
    );
  }
  return {
    host: env.HOST ?? "0.0.0.0",
    port: number("IDENTITY_PORT", 3004),
    databaseUrl,
    secretsUrl: env.SECRETS_URL ?? "http://localhost:3002",
    identityServiceToken: token("IDENTITY_SERVICE_TOKEN"),
    auditUrl: env.AUDIT_URL ?? "http://localhost:3003",
    auditToken: token("AUDIT_TOKEN"),
    auditTimeoutMs: number("AUDIT_TIMEOUT_MS", 2_000),
    publicBaseUrl,
    version: env.SERVICE_VERSION ?? "dev",
    requestTimeoutMs: number("REQUEST_TIMEOUT_MS", 30_000),
    shutdownTimeoutMs: number("SHUTDOWN_TIMEOUT_MS", 25_000),
  };
}

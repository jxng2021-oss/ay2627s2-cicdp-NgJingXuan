export interface FlagsConfig {
  host: string;
  port: number;
  databaseUrl: string;
  auditUrl: string;
  auditToken: string;
  auditTimeoutMs: number;
  version: string;
  shutdownTimeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): FlagsConfig {
  const number = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive whole number`);
    }
    return value;
  };
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL must be set");
  const auditToken = env.AUDIT_TOKEN ?? "";
  if (auditToken.length < 32) {
    throw new Error("AUDIT_TOKEN must be set, at least 32 characters");
  }
  return {
    host: env.HOST ?? "0.0.0.0",
    port: number("FLAGS_PORT", 3005),
    databaseUrl,
    auditUrl: env.AUDIT_URL ?? "http://localhost:3003",
    auditToken,
    auditTimeoutMs: number("AUDIT_TIMEOUT_MS", 2_000),
    version: env.SERVICE_VERSION ?? "dev",
    shutdownTimeoutMs: number("SHUTDOWN_TIMEOUT_MS", 25_000),
  };
}

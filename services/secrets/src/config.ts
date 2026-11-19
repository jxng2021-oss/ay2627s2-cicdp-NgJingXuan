import type { SealSettings } from "./seal/seal-manager.js";

export const DEFAULT_OPERATOR_SOCKET = "/run/secrets-operator/operator.sock";

export interface SecretsConfig {
  host: string;
  port: number;
  databaseUrl: string;
  internalServiceToken: string;
  identityServiceToken: string;
  auditUrl: string;
  auditToken: string;
  auditTimeoutMs: number;
  version: string;
  operatorSocket: string;
  maxSecretBytes: number;
  seal: SealSettings;
  headersTimeoutMs: number;
  requestTimeoutMs: number;
  shutdownTimeoutMs: number;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): SecretsConfig {
  const number = (name: string, fallback: number) => {
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
  const internalServiceToken = env.INTERNAL_SERVICE_TOKEN ?? "";
  if (internalServiceToken.length < 32) {
    throw new Error(
      "INTERNAL_SERVICE_TOKEN must be set, at least 32 characters",
    );
  }

  const identityServiceToken = env.IDENTITY_SERVICE_TOKEN ?? "";
  if (identityServiceToken.length < 32) {
    throw new Error(
      "IDENTITY_SERVICE_TOKEN must be set, at least 32 characters",
    );
  }

  const auditToken = env.AUDIT_TOKEN ?? "";
  if (auditToken.length < 32) {
    throw new Error("AUDIT_TOKEN must be set, at least 32 characters");
  }

  return {
    host: env.HOST ?? "0.0.0.0",
    port: number("SECRETS_PORT", 3002),
    auditUrl: env.AUDIT_URL ?? "http://localhost:3003",
    auditToken,
    auditTimeoutMs: number("AUDIT_TIMEOUT_MS", 2_000),
    version: env.SERVICE_VERSION ?? "dev",
    databaseUrl,
    internalServiceToken,
    identityServiceToken,
    operatorSocket: env.OPERATOR_SOCKET ?? DEFAULT_OPERATOR_SOCKET,
    maxSecretBytes: number("MAX_SECRET_BYTES", 64 * 1024),
    seal: {
      unsealTimeoutMs: number("UNSEAL_TIMEOUT_MS", 10 * 60_000),
      maxFailedAttempts: number("UNSEAL_MAX_FAILED_ATTEMPTS", 5),
      lockoutMs: number("UNSEAL_LOCKOUT_MS", 5 * 60_000),
      drainTimeoutMs: number("SEAL_DRAIN_TIMEOUT_MS", 10_000),
    },
    headersTimeoutMs: number("HEADERS_TIMEOUT_MS", 10_000),
    requestTimeoutMs: number("REQUEST_TIMEOUT_MS", 30_000),
    shutdownTimeoutMs: number("SHUTDOWN_TIMEOUT_MS", 25_000),
  };
}

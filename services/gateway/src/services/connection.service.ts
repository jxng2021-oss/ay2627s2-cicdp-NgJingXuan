import type { ConnectionBody } from "../api/proxy-schemas.js";
import type { Database } from "../db/client.js";
import {
  deleteProxyConnection,
  findProxyConnection,
  listProxyConnections,
  saveProxyConnection,
  type ProxyConnectionSettings,
} from "../models/platform.model.js";
import type { ProxyConnection } from "../db/schema.js";
import {
  policyKeys,
  policyProblem,
  utcDay,
  type ConnectionPolicy,
} from "./policy.service.js";
import {
  BlockedTargetError,
  checkBaseUrl,
  type ProxyPolicy,
} from "./ssrf.service.js";
import type { RateLimitStore } from "../rate-limit.js";
import type { AuditClient } from "../audit.js";

export interface ProxyConnectionOptions {
  db: Database;
  policy: ProxyPolicy;
  audit: AuditClient;
  rateLimitStore: RateLimitStore;
}

export async function connectionUsage(
  store: RateLimitStore,
  tenantId: string,
  connection: ProxyConnection,
) {
  const policy = connection.policy;
  const { day } = utcDay();
  const keys = policyKeys(tenantId, connection.name, day);
  try {
    const window = policy?.rateLimit ? await store.peek(keys.calls) : undefined;
    const usedToday = policy?.amountLimit
      ? await store.total(keys.amount)
      : undefined;
    return {
      name: connection.name,
      day,
      calls:
        policy?.rateLimit && window
          ? {
              used: window.count,
              limit: policy.rateLimit.requests,
              windowSeconds: policy.rateLimit.windowSeconds,
              resetSeconds: Math.ceil(window.resetMs / 1000),
            }
          : null,
      amount:
        policy?.amountLimit && usedToday !== undefined
          ? {
              field: policy.amountLimit.field,
              usedToday,
              maxPerDay: policy.amountLimit.maxPerDay,
              maxPerRequest: policy.amountLimit.maxPerRequest,
            }
          : null,
    };
  } catch {
    return undefined;
  }
}

export const RESERVED_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "transfer-encoding",
  "content-length",
  "content-type",
  "content-encoding",
  "expect",
  "cookie",
  "set-cookie",
  "x-tenant-id",
  "x-request-id",
  "x-forwarded-for",
  "forwarded",
]);

export function checkConnection(
  body: ConnectionBody,
  ssrf: ProxyPolicy,
): { settings: ProxyConnectionSettings } | { problem: string } {
  const { baseUrl, secretName, headerName, headerPrefix = "" } = body;
  const header = headerName.toLowerCase();
  if (RESERVED_HEADERS.has(header) || header.startsWith("proxy-")) {
    return { problem: `headerName can't be ${headerName}` };
  }
  const policy: ConnectionPolicy | null = body.policy ?? null;
  const problem = policy ? policyProblem(policy) : undefined;
  if (problem) return { problem };
  try {
    const url = checkBaseUrl(baseUrl, ssrf);
    return {
      settings: {
        baseUrl: url.href,
        secretName,
        headerName,
        headerPrefix,
        policy,
      },
    };
  } catch (error) {
    if (error instanceof BlockedTargetError) return { problem: error.message };
    throw error;
  }
}

export function connectionService(db: Database) {
  return {
    save: (tenantId: string, name: string, settings: ProxyConnectionSettings) =>
      saveProxyConnection(db, tenantId, name, settings),
    list: (tenantId: string) => listProxyConnections(db, tenantId),
    find: (tenantId: string, name: string) =>
      findProxyConnection(db, tenantId, name),
    remove: (tenantId: string, name: string) =>
      deleteProxyConnection(db, tenantId, name),
  };
}

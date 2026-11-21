import type { FastifyBaseLogger } from "fastify";
import type { AuditClient, AuditEvent } from "../audit.js";
import { generateApiKey } from "./api-key-tokens.service.js";
import type { Database } from "../db/client.js";
import {
  insertApiKey,
  listApiKeys,
  revokeApiKey,
} from "../models/platform.model.js";
import type { ApiKey } from "../db/schema.js";

export function apiKeyJson(key: ApiKey) {
  return {
    id: key.id,
    tenantId: key.tenantId,
    name: key.name,
    prefix: key.lookupPrefix,
    status: key.status,
    createdAt: key.createdAt,
    revokedAt: key.revokedAt,
    lastUsedAt: key.lastUsedAt,
  };
}

export interface KeyAudit {
  audit: AuditClient;
  log: FastifyBaseLogger;
  actor: Omit<AuditEvent, "action" | "tenantId" | "resourceId">;
}

export async function createApiKey(
  db: Database,
  settings: { prefix: string; hashSecret: string },
  tenantId: string,
  name: string,
  { audit, log, actor }: KeyAudit,
): Promise<{ apiKey: ApiKey; key: string }> {
  const { key, lookupPrefix, secretHash } = generateApiKey(
    settings.prefix,
    settings.hashSecret,
  );
  const apiKey = await db.transaction(async (tx) => {
    const inserted = await insertApiKey(tx, {
      tenantId,
      name,
      lookupPrefix,
      secretHash,
    });
    await audit.record(
      {
        ...actor,
        action: "api_key.created",
        tenantId,
        resourceId: inserted.id,
      },
      log,
    );
    return inserted;
  });
  return { apiKey, key };
}

export function revokeTenantApiKey(
  db: Database,
  tenantId: string,
  keyId: string,
  { audit, log, actor }: KeyAudit,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const revoked = await revokeApiKey(tx, tenantId, keyId);
    if (revoked) {
      await audit.record(
        { ...actor, action: "api_key.revoked", tenantId, resourceId: keyId },
        log,
      );
    }
    return revoked;
  });
}

export function listTenantApiKeys(db: Database, tenantId: string) {
  return listApiKeys(db, tenantId);
}

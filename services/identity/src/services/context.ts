import type { FastifyBaseLogger } from "fastify";
import type { AuditClient, AuditEvent } from "../audit.js";
import type { Database } from "../db/client.js";
import { AppError } from "../errors.js";
import { findPool, type Queryable } from "../models/identity.model.js";
import type { KeyVault } from "./key-vault.service.js";

export interface Actor {
  tenantId: string;
  actorId: string | undefined;
  actorType: "api_key" | "user";
  clientIp: string | undefined;
  requestId: string;
  log: FastifyBaseLogger;
}

export interface IdentityDeps {
  db: Database;
  audit: AuditClient;
  keyVault: KeyVault;
  publicBaseUrl: string;
  now: () => number;
}

export const poolNotFound = () =>
  new AppError(404, "NOT_FOUND", "User pool not found");
export const userNotFound = () =>
  new AppError(404, "NOT_FOUND", "User not found");
export const roleNotFound = () =>
  new AppError(404, "NOT_FOUND", "Role not found");

export function auditEvent(
  actor: Actor,
  action: string,
  outcome: AuditEvent["outcome"],
  resourceId?: string,
): AuditEvent {
  return {
    action,
    outcome,
    actorType: actor.actorId ? actor.actorType : "service",
    tenantId: actor.tenantId,
    ...(actor.actorId ? { actorId: actor.actorId } : {}),
    ...(resourceId ? { resourceId } : {}),
    requestId: actor.requestId,
    ...(actor.clientIp ? { sourceIp: actor.clientIp } : {}),
  };
}

export function recorder({ db, audit }: IdentityDeps) {
  return <T>(
    actor: Actor,
    change: (tx: Queryable) => Promise<T | undefined>,
    audited: (result: T) => AuditEvent,
  ): Promise<T | undefined> =>
    db.transaction(async (tx) => {
      const result = await change(tx);
      if (result !== undefined) await audit.record(audited(result), actor.log);
      return result;
    });
}

export async function poolOf(db: Database, actor: Actor, poolId: string) {
  const pool = await findPool(db, actor.tenantId, poolId);
  if (!pool) throw poolNotFound();
  return pool;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isUniqueViolation(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : undefined;
  const cause =
    typeof error === "object" && error !== null && "cause" in error
      ? error.cause
      : undefined;
  return code === "23505" || (cause !== undefined && isUniqueViolation(cause));
}

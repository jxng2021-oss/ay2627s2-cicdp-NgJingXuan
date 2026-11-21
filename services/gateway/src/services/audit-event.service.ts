import type { FastifyRequest } from "fastify";
import type { AuditEvent } from "../audit.js";

export function apiKeyEvent(
  request: FastifyRequest,
  action: string,
  resourceId: string,
  outcome: AuditEvent["outcome"] = "success",
): AuditEvent {
  return {
    action,
    outcome,
    actorType: "api_key",
    actorId: request.apiKeyId,
    tenantId: request.tenantId,
    resourceId,
    requestId: request.id,
    sourceIp: request.ip,
  };
}

export function adminEvent(
  request: FastifyRequest,
  action: string,
  tenantId: string,
  resourceId: string,
): AuditEvent {
  return {
    action,
    outcome: "success",
    actorType: "admin",
    tenantId,
    resourceId,
    requestId: request.id,
    sourceIp: request.ip,
  };
}

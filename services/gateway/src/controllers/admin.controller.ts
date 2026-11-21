import type { FastifyReply, FastifyRequest } from "fastify";
import type { Tenant } from "../db/schema.js";
import { sendError } from "../errors.js";
import type { AdminRoutesOptions } from "../routes/admin.routes.js";
import {
  apiKeyJson,
  createApiKey,
  listTenantApiKeys,
  revokeTenantApiKey,
} from "../services/api-key.service.js";
import { adminEvent } from "../services/audit-event.service.js";
import { tenantService } from "../services/tenant.service.js";

type TenantReq = FastifyRequest<{ Params: { tenantId: string } }>;

export function createAdminController(options: AdminRoutesOptions) {
  const { db, audit } = options;
  const tenants = tenantService(db, audit);

  return {
    createTenant: async (
      request: FastifyRequest<{ Body: { name: string } }>,
      reply: FastifyReply,
    ) => {
      const tenant = await tenants.create(
        request.body.name,
        (id) => adminEvent(request, "tenant.created", id, id),
        request.log,
      );
      return reply.code(201).send(tenantJson(tenant));
    },

    suspendTenant: async (request: TenantReq, reply: FastifyReply) => {
      const { tenantId } = request.params;
      const tenant = await tenants.suspend(
        tenantId,
        adminEvent(request, "tenant.suspended", tenantId, tenantId),
        request.log,
      );
      if (!tenant) return tenantNotFound(reply);
      return tenantJson(tenant);
    },

    createKey: async (
      request: FastifyRequest<{
        Params: { tenantId: string };
        Body: { name: string };
      }>,
      reply: FastifyReply,
    ) => {
      const tenant = await tenants.find(request.params.tenantId);
      if (!tenant) return tenantNotFound(reply);
      const { apiKey, key } = await createApiKey(
        db,
        { prefix: options.apiKeyPrefix, hashSecret: options.apiKeyHashSecret },
        tenant.id,
        request.body.name,
        { audit, log: request.log, actor: adminActor(request) },
      );
      return reply.code(201).send({
        ...apiKeyJson(apiKey),
        key,
        warning: "Store this key now. It can't be shown again.",
      });
    },

    listKeys: async (request: TenantReq, reply: FastifyReply) => {
      const tenant = await tenants.find(request.params.tenantId);
      if (!tenant) return tenantNotFound(reply);
      const keys = await listTenantApiKeys(db, tenant.id);
      return { apiKeys: keys.map(apiKeyJson) };
    },

    revokeKey: async (
      request: FastifyRequest<{ Params: { tenantId: string; keyId: string } }>,
      reply: FastifyReply,
    ) => {
      const { tenantId, keyId } = request.params;
      const revoked = await revokeTenantApiKey(db, tenantId, keyId, {
        audit,
        log: request.log,
        actor: adminActor(request),
      });
      if (!revoked) {
        return sendError(reply, 404, "NOT_FOUND", "API key not found");
      }
      return reply.code(204).send();
    },
  };
}

function tenantNotFound(reply: FastifyReply) {
  return sendError(reply, 404, "NOT_FOUND", "Tenant not found");
}

function tenantJson(tenant: Tenant) {
  return {
    id: tenant.id,
    name: tenant.name,
    status: tenant.status,
    createdAt: tenant.createdAt,
    updatedAt: tenant.updatedAt,
  };
}

function adminActor(request: FastifyRequest) {
  return {
    outcome: "success",
    actorType: "admin",
    requestId: request.id,
    sourceIp: request.ip,
  } as const;
}

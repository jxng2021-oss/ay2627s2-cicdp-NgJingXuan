import type { FastifyReply, FastifyRequest } from "fastify";
import { sendError } from "../../errors.js";
import {
  apiKeyJson,
  listTenantApiKeys,
  createApiKey,
  revokeTenantApiKey,
  deleteRevokedTenantApiKey,
  type KeyAudit,
} from "../../services/api-key.service.js";
import type { DashboardOptions } from "../../routes/dashboard/index.js";

export function apiKeysController(options: DashboardOptions) {
  const { db, audit } = options;

  const asUser = (request: FastifyRequest): KeyAudit => ({
    audit,
    log: request.log,
    actor: {
      outcome: "success",
      actorType: "user",
      actorId: request.dashboardUserId,
      requestId: request.id,
      sourceIp: request.ip,
    },
  });

  return {
    list: async (request: FastifyRequest) => {
      const keys = await listTenantApiKeys(db, request.tenantId);
      return { apiKeys: keys.map(apiKeyJson) };
    },

    create: async (
      request: FastifyRequest<{ Body: { name: string } }>,
      reply: FastifyReply,
    ) => {
      const { apiKey, key } = await createApiKey(
        db,
        { prefix: options.apiKeyPrefix, hashSecret: options.apiKeyHashSecret },
        request.tenantId,
        request.body.name,
        asUser(request),
      );
      return reply.code(201).send({
        apiKey: apiKeyJson(apiKey),
        key,
        warning: "Store this key now. It can't be shown again.",
      });
    },

    revoke: async (request: FastifyRequest, reply: FastifyReply) => {
      const { keyId } = request.params as { keyId: string };
      if (
        !(await revokeTenantApiKey(
          db,
          request.tenantId,
          keyId,
          asUser(request),
        ))
      ) {
        return sendError(reply, 404, "NOT_FOUND", "API key not found");
      }
      return reply.code(204).send();
    },

    remove: async (request: FastifyRequest, reply: FastifyReply) => {
      const { keyId } = request.params as { keyId: string };
      const result = await deleteRevokedTenantApiKey(
        db,
        request.tenantId,
        keyId,
        asUser(request),
      );
      if (result === "missing") {
        return sendError(reply, 404, "NOT_FOUND", "API key not found");
      }
      if (result === "active") {
        return sendError(
          reply,
          409,
          "CONFLICT",
          "Revoke the API key before removing it",
        );
      }
      return reply.code(204).send();
    },
  };
}

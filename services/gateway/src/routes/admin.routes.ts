import type { FastifyBaseLogger, FastifyPluginCallback } from "fastify";
import type { AuditClient } from "../audit.js";
import { createAdminController } from "../controllers/admin.controller.js";
import type { Database } from "../db/client.js";
import { sendError } from "../errors.js";
import {
  rateLimited,
  serviceUnavailable,
  setRateLimitHeaders,
} from "../limits.js";
import type { RateLimiter } from "../rate-limit.js";
import {
  bearerToken,
  secretsEqual,
} from "../services/api-key-tokens.service.js";

export interface AdminRoutesOptions {
  db: Database;
  adminToken: string;
  apiKeyPrefix: string;
  apiKeyHashSecret: string;
  adminLimiter: RateLimiter;
  audit: AuditClient;
  warnRateLimitingDown: (log: FastifyBaseLogger, error: unknown) => void;
}

const UUID = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const nameBody = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: { name: { type: "string", minLength: 1, maxLength: 100 } },
} as const;
const tenantParams = {
  type: "object",
  required: ["tenantId"],
  properties: { tenantId: { type: "string", pattern: UUID } },
} as const;
const keyParams = {
  type: "object",
  required: ["tenantId", "keyId"],
  properties: {
    tenantId: { type: "string", pattern: UUID },
    keyId: { type: "string", pattern: UUID },
  },
} as const;

export const adminRoutes: FastifyPluginCallback<AdminRoutesOptions> = (
  app,
  options,
  done,
) => {
  app.addHook("onRequest", async (request, reply) => {
    try {
      const limit = await options.adminLimiter.consume(request.ip);
      setRateLimitHeaders(reply, limit);
      if (!limit.allowed) return rateLimited(reply, limit.resetSeconds);
    } catch (error) {
      options.warnRateLimitingDown(request.log, error);
      return serviceUnavailable(
        reply,
        "The admin API is temporarily unavailable",
      );
    }

    const token = bearerToken(request.headers.authorization);
    if (token === undefined || !secretsEqual(token, options.adminToken)) {
      reply.header("www-authenticate", "Bearer");
      return sendError(
        reply,
        401,
        "UNAUTHORIZED",
        "A valid admin token is required",
      );
    }
  });

  const c = createAdminController(options);
  app.post("/tenants", { schema: { body: nameBody } }, c.createTenant);
  app.post(
    "/tenants/:tenantId/suspend",
    { schema: { params: tenantParams } },
    c.suspendTenant,
  );
  app.post(
    "/tenants/:tenantId/api-keys",
    { schema: { params: tenantParams, body: nameBody } },
    c.createKey,
  );
  app.get(
    "/tenants/:tenantId/api-keys",
    { schema: { params: tenantParams } },
    c.listKeys,
  );
  app.delete(
    "/tenants/:tenantId/api-keys/:keyId",
    { schema: { params: keyParams } },
    c.revokeKey,
  );
  done();
};

import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyRequest,
} from "fastify";
import {
  apiKeyMatches,
  bearerToken,
  parseApiKey,
} from "../services/api-key-tokens.service.js";
import type { Database } from "../db/client.js";
import {
  findKeyForAuthentication,
  touchApiKey,
} from "../models/platform.model.js";
import { sendError } from "../errors.js";
import {
  rateLimited,
  serviceUnavailable,
  setRateLimitHeaders,
} from "../limits.js";
import type { RateLimiter } from "../rate-limit.js";

export interface ApiKeyAuthOptions {
  db: Database;
  apiKeyHashSecret: string;
  limiters: {
    perKey: RateLimiter;
    uploadsPerKey: RateLimiter;
    failedAuthPerIp: RateLimiter;
  };
  warnRateLimitingDown: (log: FastifyBaseLogger, error: unknown) => void;
}

declare module "fastify" {
  interface FastifyRequest {
    tenantId: string;
    apiKeyId: string;
  }
}

const UPLOAD_ROUTE = "/v1/storage/files";

export function addApiKeyAuthentication(
  app: FastifyInstance,
  options: ApiKeyAuthOptions,
): void {
  const { limiters } = options;
  app.decorateRequest("tenantId", "");
  app.decorateRequest("apiKeyId", "");

  app.addHook("onRequest", async (request, reply) => {
    const ip = request.ip;

    try {
      const failures = await limiters.failedAuthPerIp.isOverLimit(ip);
      if (!failures.allowed) return rateLimited(reply, failures.resetSeconds);
    } catch (error) {
      options.warnRateLimitingDown(request.log, error);
    }

    const found = await authenticate(request, options);
    if (!found) {
      try {
        await limiters.failedAuthPerIp.consume(ip);
      } catch (error) {
        options.warnRateLimitingDown(request.log, error);
        return serviceUnavailable(
          reply,
          "Service temporarily unavailable, try again later",
        );
      }
      reply.header("www-authenticate", "Bearer");
      return sendError(
        reply,
        401,
        "UNAUTHORIZED",
        "A valid API key is required",
      );
    }

    if (found.tenantStatus !== "active") {
      return sendError(reply, 403, "FORBIDDEN", "This tenant is suspended");
    }

    try {
      const perKey = await limiters.perKey.consume(found.keyId);
      setRateLimitHeaders(reply, perKey);
      if (!perKey.allowed) return rateLimited(reply, perKey.resetSeconds);

      if (
        request.method === "POST" &&
        request.routeOptions.url === UPLOAD_ROUTE
      ) {
        const uploads = await limiters.uploadsPerKey.consume(found.keyId);
        if (!uploads.allowed) {
          setRateLimitHeaders(reply, uploads);
          return rateLimited(reply, uploads.resetSeconds);
        }
      }
    } catch (error) {
      options.warnRateLimitingDown(request.log, error);
    }

    request.tenantId = found.tenantId;
    request.apiKeyId = found.keyId;
    await touchApiKey(options.db, found.keyId);
  });
}

async function authenticate(
  request: FastifyRequest,
  options: ApiKeyAuthOptions,
) {
  const key = bearerToken(request.headers.authorization);
  const parsed = key === undefined ? undefined : parseApiKey(key);
  const found = parsed
    ? await findKeyForAuthentication(options.db, parsed.lookupPrefix)
    : undefined;
  if (
    key === undefined ||
    !found ||
    !apiKeyMatches(key, found.key.secretHash, options.apiKeyHashSecret) ||
    found.key.status !== "active"
  ) {
    return undefined;
  }
  return {
    keyId: found.key.id,
    tenantId: found.tenant.id,
    tenantStatus: found.tenant.status,
  };
}

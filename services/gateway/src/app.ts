import { randomUUID } from "node:crypto";
import { createServer, type RequestListener } from "node:http";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { sql } from "drizzle-orm";
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import { openApiOptions } from "./api/openapi.js";
import { healthSchema, readinessSchema } from "./api/schemas.js";
import type { AuditClient } from "./audit.js";
import type { Database } from "./db/client.js";
import { installErrorHandling, sendError } from "./errors.js";
import { rateLimitingDownWarning, type RateLimitSettings } from "./limits.js";
import { loggerOptions, logRequests } from "./logging.js";
import { RateLimiter, type RateLimitStore } from "./rate-limit.js";
import { adminRoutes } from "./routes/admin.routes.js";
import {
  systemResolver,
  type ProxyPolicy,
  type Resolver,
} from "./services/ssrf.service.js";
import { publicApiV1 } from "./routes/public-api.routes.js";

export interface ServerLimits {
  maxHeaderBytes: number;
  headersTimeoutMs: number;
  requestTimeoutMs: number;
  keepAliveTimeoutMs: number;
  idleTimeoutMs: number;
}

export interface GatewayAppOptions {
  db: Database;
  rateLimitStore: RateLimitStore;
  rateLimits: RateLimitSettings;
  adminToken: string;
  apiKeyHashSecret: string;
  apiKeyPrefix: string;
  storageUrl: string;
  secretsUrl: string;
  connectTimeoutMs: number;
  responseTimeoutMs: number;
  maxUploadBytes: number;
  maxSecretBytes: number;
  server: ServerLimits;
  trustProxy: false | string[];
  apiDocsEnabled?: boolean;
  adminApiEnabled?: boolean;
  proxy: ProxyPolicy;
  resolver?: Resolver;
  audit: AuditClient;
  auditUrl: string;
  auditToken: string;
  version?: string;
  logger?: FastifyServerOptions["logger"];
}

export function buildApp(options: GatewayAppOptions): FastifyInstance {
  const limits = options.server;
  const app = Fastify({
    logger: loggerOptions(options.logger, "gateway", options.version ?? "dev"),
    trustProxy: options.trustProxy,
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    logController: new LogController({
      requestIdLogLabel: "requestId",
      disableRequestLogging: true,
    }),
    ajv: { customOptions: { keywords: ["example"] } },
    routerOptions: { maxParamLength: 256 },
    return503OnClosing: false,
    serverFactory: (handler: RequestListener) => {
      const server = createServer(
        {
          maxHeaderSize: limits.maxHeaderBytes,
          headersTimeout: limits.headersTimeoutMs,
          requestTimeout: limits.requestTimeoutMs,
          keepAliveTimeout: limits.keepAliveTimeoutMs,
          connectionsCheckingInterval: 1_000,
        },
        handler,
      );
      server.setTimeout(limits.idleTimeoutMs);
      return server;
    },
  });

  installErrorHandling(app);
  logRequests(app);

  let shuttingDown = false;
  app.addHook("preClose", (done) => {
    shuttingDown = true;
    done();
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
    if (shuttingDown) {
      reply.header("connection", "close");
      return sendError(
        reply,
        503,
        "SERVICE_UNAVAILABLE",
        "The server is shutting down, try again",
      );
    }
  });

  app.register(swagger, openApiOptions);
  if (options.apiDocsEnabled) {
    app.register(swaggerUi, { routePrefix: "/docs" });
  }

  const { rateLimits, rateLimitStore } = options;
  const limiter = (name: string, limit: number) =>
    new RateLimiter(rateLimitStore, name, limit, rateLimits.windowMs);
  const warnRateLimitingDown = rateLimitingDownWarning();

  app.register((routes, _opts, done) => {
    const api = routes.withTypeProvider<TypeBoxTypeProvider>();

    api.get("/health", { schema: healthSchema }, () => ({
      status: "ok" as const,
    }));

    api.get("/ready", { schema: readinessSchema }, async (_request, reply) => {
      const [postgres, redis] = await Promise.all([
        check(() => options.db.execute(sql`select 1`)),
        check(() => options.rateLimitStore.ping()),
      ]);
      const ready = postgres === "up";
      return reply.code(ready ? 200 : 503).send({
        status: ready ? (redis === "up" ? "ready" : "degraded") : "not_ready",
        checks: { postgres, redis },
      });
    });

    if (options.adminApiEnabled) {
      routes.register(adminRoutes, {
        prefix: "/admin",
        ...options,
        adminLimiter: limiter("admin-ip", rateLimits.adminPerIp),
        warnRateLimitingDown,
      });
    }

    routes.register(publicApiV1, {
      prefix: "/v1",
      ...options,
      resolver: options.resolver ?? systemResolver,
      limiters: {
        perKey: limiter("key", rateLimits.requestsPerKey),
        uploadsPerKey: limiter("key-uploads", rateLimits.uploadsPerKey),
        failedAuthPerIp: limiter("failed-auth-ip", rateLimits.failedAuthPerIp),
      },
      warnRateLimitingDown,
    });
    done();
  });

  return app;
}

async function check(probe: () => Promise<unknown>): Promise<"up" | "down"> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), 1_000);
  });
  try {
    await Promise.race([probe(), timeout]);
    return "up";
  } catch {
    return "down";
  } finally {
    clearTimeout(timer);
  }
}

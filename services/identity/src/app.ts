import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
} from "node:http";
import { BlockList, isIP, isIPv4 } from "node:net";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { sql } from "drizzle-orm";
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import type { AuditClient } from "./audit.js";
import { createIdentityController } from "./controllers/identity.controller.js";
import type { Database } from "./db/client.js";
import { installErrorHandling, sendError } from "./errors.js";
import { loggerOptions, logRequests } from "./logging.js";
import { identityRoutes } from "./routes/identity.routes.js";
import type { IdentityDeps } from "./services/context.js";
import type { KeyVault } from "./services/key-vault.service.js";
import { createPoolService } from "./services/pool.service.js";
import { createRoleService } from "./services/role.service.js";
import { createSessionService } from "./services/session.service.js";
import { createUserService } from "./services/user.service.js";
import { validatorCompiler } from "./validation.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const INTERNAL_NETWORKS = new BlockList();
INTERNAL_NETWORKS.addSubnet("10.0.0.0", 8, "ipv4");
INTERNAL_NETWORKS.addSubnet("172.16.0.0", 12, "ipv4");
INTERNAL_NETWORKS.addSubnet("192.168.0.0", 16, "ipv4");
INTERNAL_NETWORKS.addSubnet("127.0.0.0", 8, "ipv4");
INTERNAL_NETWORKS.addAddress("::1", "ipv6");
INTERNAL_NETWORKS.addSubnet("fc00::", 7, "ipv6");

export { normalizeEmail } from "./services/context.js";
export {
  MAX_ROLES_PER_POOL,
  MAX_ROLES_PER_USER,
} from "./services/role.service.js";
export { LOCK_AFTER, LOCK_MS } from "./services/session.service.js";

export interface IdentityAppOptions {
  db: Database;
  keyVault: KeyVault;
  audit: AuditClient;
  publicBaseUrl: string;
  version?: string;
  requestTimeoutMs?: number;
  logger?: FastifyServerOptions["logger"];
  now?: () => number;
}

declare module "fastify" {
  interface FastifyRequest {
    tenantId: string;
    actorId: string | undefined;
    actorType: "api_key" | "user";
    clientIp: string | undefined;
  }
}

export function buildApp({
  db,
  keyVault,
  audit,
  publicBaseUrl,
  version = "dev",
  requestTimeoutMs = 30_000,
  logger = false,
  now = Date.now,
}: IdentityAppOptions): FastifyInstance {
  const app = Fastify({
    logger: loggerOptions(logger, "identity", version),
    requestIdHeader: false,
    genReqId: (request: IncomingMessage) => {
      const id = request.headers["x-request-id"];
      return typeof id === "string" && UUID_PATTERN.test(id)
        ? id
        : randomUUID();
    },
    logController: new LogController({
      requestIdLogLabel: "requestId",
      disableRequestLogging: true,
    }),
    bodyLimit: 16 * 1024,
    return503OnClosing: false,
    serverFactory: (handler: RequestListener) =>
      createServer(
        {
          headersTimeout: 10_000,
          requestTimeout: requestTimeoutMs,
          connectionsCheckingInterval: 1_000,
        },
        handler,
      ),
  }).withTypeProvider<TypeBoxTypeProvider>();

  installErrorHandling(app);
  app.setValidatorCompiler(validatorCompiler);
  app.removeContentTypeParser("text/plain");
  logRequests(app);

  app.decorateRequest("tenantId", "");
  app.decorateRequest("actorId", undefined);
  app.decorateRequest("actorType", "api_key");
  app.decorateRequest("clientIp", undefined);

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
        "The server is shutting down",
      );
    }
    if (!isInternalAddress(request.ip)) {
      return sendError(
        reply,
        403,
        "FORBIDDEN",
        "Only internal traffic is accepted",
      );
    }
    if (["/health", "/ready"].includes(request.url)) return;
    if (request.url.startsWith("/public/")) return;

    reply.header("cache-control", "no-store");
    const tenantId = request.headers["x-tenant-id"];
    if (typeof tenantId !== "string" || !UUID_PATTERN.test(tenantId)) {
      return sendError(
        reply,
        400,
        "BAD_REQUEST",
        "A valid X-Tenant-Id header is required",
      );
    }
    request.tenantId = tenantId;
    const actorId = request.headers["x-actor-id"];
    if (typeof actorId === "string" && UUID_PATTERN.test(actorId)) {
      request.actorId = actorId;
      request.actorType =
        request.headers["x-actor-type"] === "user" ? "user" : "api_key";
    }
    const clientIp = request.headers["x-client-ip"];
    if (typeof clientIp === "string" && isIP(clientIp) !== 0) {
      request.clientIp = clientIp;
    }
  });

  app.get("/health", () => ({ status: "ok" }));
  app.get("/ready", async (_request, reply) => {
    let postgres: "up" | "down" = "up";
    try {
      await db.execute(sql`select 1`);
    } catch {
      postgres = "down";
    }
    return reply.code(postgres === "up" ? 200 : 503).send({
      status: postgres === "up" ? "ready" : "not_ready",
      checks: { postgres },
    });
  });
  const deps: IdentityDeps = { db, audit, keyVault, publicBaseUrl, now };
  const users = createUserService(deps);
  identityRoutes(
    app,
    createIdentityController({
      pools: createPoolService(deps),
      users,
      sessions: createSessionService(deps),
      roles: createRoleService(deps, users),
      publicBaseUrl,
      now,
    }),
  );

  return app;
}

function isInternalAddress(ip: string): boolean {
  const plain = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  return INTERNAL_NETWORKS.check(plain, isIPv4(plain) ? "ipv4" : "ipv6");
}

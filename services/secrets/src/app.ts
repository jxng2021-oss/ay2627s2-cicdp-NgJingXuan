import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
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
import { createKeyController } from "./controllers/key.controller.js";
import { createSecretController } from "./controllers/secret.controller.js";
import type { KeyProvider } from "./crypto/key-provider.js";
import type { Database } from "./db/client.js";
import { installErrorHandling, sendError } from "./errors.js";
import { loggerOptions, logRequests } from "./logging.js";
import { secretRoutes } from "./routes/secret.routes.js";
import { SecretService } from "./services/secret.service.js";
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

export interface SecretsAppOptions {
  db: Database;
  keyProvider: KeyProvider;
  maxSecretBytes: number;
  internalServiceToken: string;
  identityServiceToken: string;
  audit: AuditClient;
  version?: string;
  headersTimeoutMs?: number;
  requestTimeoutMs?: number;
  logger?: FastifyServerOptions["logger"];
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
  keyProvider,
  maxSecretBytes,
  internalServiceToken,
  identityServiceToken,
  audit,
  version = "dev",
  headersTimeoutMs = 10_000,
  requestTimeoutMs = 30_000,
  logger = false,
}: SecretsAppOptions): FastifyInstance {
  const app = Fastify({
    logger: loggerOptions(logger, "secrets", version),
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
    bodyLimit: maxSecretBytes * 6 + 1024,
    routerOptions: { maxParamLength: 256 },
    return503OnClosing: false,
    serverFactory: (handler: RequestListener) =>
      createServer(
        {
          headersTimeout: headersTimeoutMs,
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

    const route = request.routeOptions.url ?? "";

    if (
      route.startsWith("/internal/file-keys/") &&
      !tokenMatches(request.headers.authorization, internalServiceToken)
    ) {
      return sendError(reply, 403, "FORBIDDEN", "Not allowed");
    }
    if (
      route.startsWith("/internal/signing-keys/") &&
      !tokenMatches(request.headers.authorization, identityServiceToken)
    ) {
      return sendError(reply, 403, "FORBIDDEN", "Not allowed");
    }
    if (!route.startsWith("/secrets") && !route.startsWith("/internal/"))
      return;
    if (!keyProvider.beginRequest()) {
      reply.header("retry-after", 30);
      return sendError(
        reply,
        503,
        "SECRETS_SEALED",
        keyProvider.state === "uninitialised"
          ? "The secrets service hasn't been initialised yet"
          : "The secrets service is sealed until an operator unseals it",
      );
    }
    reply.raw.once("close", () => keyProvider.endRequest());
  });

  app.get("/health", () => ({ status: "ok" }));

  app.get("/ready", async (_request, reply) => {
    let postgres: "up" | "down" = "up";
    try {
      await db.execute(sql`select 1`);
    } catch {
      postgres = "down";
    }
    const seal = keyProvider.state;
    const reason =
      postgres === "down"
        ? "postgres_down"
        : seal === "uninitialised"
          ? "not_initialised"
          : seal === "sealed"
            ? "sealed"
            : undefined;
    return reply.code(reason ? 503 : 200).send({
      status: reason ? "not_ready" : "ready",
      ...(reason ? { reason } : {}),
      checks: { postgres, seal },
    });
  });

  const secrets = new SecretService(db, keyProvider);
  secretRoutes(
    app,
    createSecretController(secrets, audit, maxSecretBytes),
    createKeyController(secrets),
  );

  return app;
}

function tokenMatches(header: string | undefined, expected: string): boolean {
  const given = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const digest = (text: string) => createHash("sha256").update(text).digest();
  return timingSafeEqual(digest(given), digest(expected)) && given.length > 0;
}

function isInternalAddress(ip: string): boolean {
  const plain = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  return INTERNAL_NETWORKS.check(plain, isIPv4(plain) ? "ipv4" : "ipv6");
}

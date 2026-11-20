import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { BlockList, isIPv4 } from "node:net";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { sql } from "drizzle-orm";
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import { SERVICES, type ServiceName } from "./actions.js";
import { createEventController } from "./controllers/event.controller.js";
import type { Database } from "./db/client.js";
import { installErrorHandling, sendError } from "./errors.js";
import { loggerOptions, logRequests } from "./logging.js";
import { eventRoutes } from "./routes/event.routes.js";
import { createEventService } from "./services/event.service.js";
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

export interface AuditAppOptions {
  db: Database;
  hmacKey: string;
  serviceTokens: Record<ServiceName, string>;
  version?: string;
  logger?: FastifyServerOptions["logger"];
}

declare module "fastify" {
  interface FastifyRequest {
    caller: ServiceName | undefined;
  }
}

export function buildApp(options: AuditAppOptions): FastifyInstance {
  const { db, hmacKey } = options;
  const app = Fastify({
    logger: loggerOptions(options.logger, "audit", options.version ?? "dev"),
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
    bodyLimit: 4096,
    return503OnClosing: false,
  }).withTypeProvider<TypeBoxTypeProvider>();

  installErrorHandling(app);
  app.setValidatorCompiler(validatorCompiler);
  app.removeContentTypeParser("text/plain");
  logRequests(app);

  app.decorateRequest("caller", undefined);

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

    const service = request.headers["x-audit-service"];
    const known = SERVICES.find((name) => name === service);
    if (
      !known ||
      !tokenMatches(request.headers.authorization, options.serviceTokens[known])
    ) {
      return sendError(reply, 403, "FORBIDDEN", "Not allowed");
    }
    request.caller = known;
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

  eventRoutes(app, createEventController(createEventService(db, hmacKey)));

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

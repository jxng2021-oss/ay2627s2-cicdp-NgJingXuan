import type { FastifyReply, FastifyRequest } from "fastify";
import { sendError } from "../errors.js";
import { rateLimited, serviceUnavailable } from "../limits.js";
import type { RateLimiter } from "../rate-limit.js";
import type { WebhookService } from "../services/webhook.service.js";
import type { WebhookSigner } from "../services/webhook-signing.service.js";

export interface WebhooksControllerOptions {
  webhooks: WebhookService;
  signer: WebhookSigner;
  failuresPerIp: RateLimiter;
  warnRateLimitingDown: (log: FastifyRequest["log"], error: unknown) => void;
}

type Receive = FastifyRequest<{
  Params: { endpointId: string };
  Body: Buffer;
}>;
type Pull = FastifyRequest<{
  Querystring: { after?: string; limit?: number; endpointId?: string };
}>;

export function webhooksController(options: WebhooksControllerOptions) {
  async function blocked(request: FastifyRequest, reply: FastifyReply) {
    try {
      const failures = await options.failuresPerIp.isOverLimit(request.ip);
      return failures.allowed
        ? undefined
        : rateLimited(reply, failures.resetSeconds);
    } catch (error) {
      options.warnRateLimitingDown(request.log, error);
      return undefined;
    }
  }

  async function countFailure(request: FastifyRequest) {
    await options.failuresPerIp.consume(request.ip).catch(() => undefined);
  }

  return {
    receive: async (request: Receive, reply: FastifyReply) => {
      const refused = await blocked(request, reply);
      if (refused) return refused;
      const header = request.headers["stripe-signature"];
      const result = await options.webhooks.receive(
        request.params.endpointId,
        Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
        typeof header === "string" ? header : undefined,
        { requestId: request.id, clientIp: request.ip, log: request.log },
      );
      switch (result.status) {
        case "accepted":
        case "ignored":
          return { received: true };
        case "invalid":
          return sendError(
            reply,
            400,
            "BAD_REQUEST",
            "The body isn't a Stripe event",
          );
        case "sealed":
          reply.header("retry-after", 30);
          return sendError(
            reply,
            503,
            "SECRETS_SEALED",
            "The secrets service is sealed until an operator unseals it",
          );
        case "unavailable":
          return serviceUnavailable(
            reply,
            "The webhook's signing secret can't be read right now",
          );
        default:
          await countFailure(request);
          return sendError(
            reply,
            401,
            "UNAUTHORIZED",
            "The webhook signature is missing or wrong",
          );
      }
    },

    keys: (_request: FastifyRequest, reply: FastifyReply) => {
      reply.header("cache-control", "public, max-age=300");
      return options.signer.jwks();
    },

    pull: async (request: Pull) => {
      const { after, limit, endpointId } = request.query;
      return options.webhooks.pull(
        request.tenantId,
        Number(after ?? 0),
        limit ?? 50,
        endpointId,
      );
    },
  };
}

import type { FastifyReply, FastifyRequest } from "fastify";
import type { WebhookEndpoint, WebhookEvent } from "../../db/schema.js";
import { sendError } from "../../errors.js";
import {
  MAX_WEBHOOK_ENDPOINTS,
  webhookEndpointService,
  WebhookSettingsError,
} from "../../services/webhook-endpoint.service.js";
import type { DashboardOptions } from "../../routes/dashboard/index.js";

type Params = { workspaceId: string; endpointId: string };

export function dashboardWebhooksController(options: DashboardOptions) {
  const endpoints = webhookEndpointService(options.db, options.proxy);
  const origin = options.dashboard.oauth.redirectOrigin;

  const toJson = (endpoint: WebhookEndpoint) => ({
    id: endpoint.id,
    name: endpoint.name,
    provider: "stripe" as const,
    signingSecretName: endpoint.signingSecretName,
    forwardUrl: endpoint.forwardUrl,
    stripeUrl: `${origin}/v1/webhooks/${endpoint.id}`,
    createdAt: endpoint.createdAt.toISOString(),
  });

  const eventJson = (event: WebhookEvent) => ({
    id: event.id,
    event: event.data.event,
    providerEventId: event.data.providerEventId,
    orderId: event.data.orderId,
    amount: event.data.amount,
    currency: event.data.currency,
    paymentId: event.data.paymentId,
    reason: event.data.reason,
    occurredAt: event.data.occurredAt,
    receivedAt: event.receivedAt.toISOString(),
    deliveryStatus: event.deliveryStatus as
      "pending" | "delivered" | "failed" | "pull",
    attempts: event.attempts,
    lastError: event.lastError,
    deliveredAt: event.deliveredAt?.toISOString() ?? null,
  });

  const record = (request: FastifyRequest, action: string, id: string) =>
    void options.audit.recordBestEffort(
      {
        action,
        outcome: "success",
        actorType: "user",
        actorId: request.dashboardUserId,
        tenantId: request.tenantId,
        resourceId: id,
        requestId: request.id,
        sourceIp: request.ip,
      },
      request.log,
    );

  const notFound = (reply: FastifyReply) =>
    sendError(reply, 404, "NOT_FOUND", "Webhook endpoint not found");

  return {
    list: async (request: FastifyRequest) => ({
      endpoints: (await endpoints.list(request.tenantId)).map(toJson),
    }),

    create: async (
      request: FastifyRequest<{
        Body: {
          name: string;
          signingSecretName: string;
          forwardUrl: string | null;
        };
      }>,
      reply: FastifyReply,
    ) => {
      try {
        const created = await endpoints.create(request.tenantId, request.body);
        if (created === "taken") {
          return sendError(
            reply,
            409,
            "CONFLICT",
            "A webhook endpoint with this name already exists",
          );
        }
        if (created === "too_many") {
          return sendError(
            reply,
            409,
            "CONFLICT",
            `A workspace can have at most ${MAX_WEBHOOK_ENDPOINTS} webhook endpoints`,
          );
        }
        record(request, "webhook_endpoint.created", created.id);
        return reply.code(201).send(toJson(created));
      } catch (error) {
        if (error instanceof WebhookSettingsError) {
          return sendError(reply, 400, "BAD_REQUEST", error.message);
        }
        throw error;
      }
    },

    update: async (
      request: FastifyRequest<{
        Params: Params;
        Body: { signingSecretName?: string; forwardUrl?: string | null };
      }>,
      reply: FastifyReply,
    ) => {
      try {
        const updated = await endpoints.update(
          request.tenantId,
          request.params.endpointId,
          request.body,
        );
        if (!updated) return notFound(reply);
        record(request, "webhook_endpoint.updated", updated.id);
        return toJson(updated);
      } catch (error) {
        if (error instanceof WebhookSettingsError) {
          return sendError(reply, 400, "BAD_REQUEST", error.message);
        }
        throw error;
      }
    },

    remove: async (
      request: FastifyRequest<{ Params: Params }>,
      reply: FastifyReply,
    ) => {
      const id = request.params.endpointId;
      if (!(await endpoints.remove(request.tenantId, id))) {
        return notFound(reply);
      }
      record(request, "webhook_endpoint.deleted", id);
      return reply.code(204).send();
    },

    events: async (
      request: FastifyRequest<{ Params: Params }>,
      reply: FastifyReply,
    ) => {
      const id = request.params.endpointId;
      if (!(await endpoints.find(request.tenantId, id))) return notFound(reply);
      return {
        events: (await endpoints.events(request.tenantId, id)).map(eventJson),
      };
    },

    redeliver: async (
      request: FastifyRequest<{ Params: Params & { eventId: string } }>,
      reply: FastifyReply,
    ) => {
      const endpoint = await endpoints.find(
        request.tenantId,
        request.params.endpointId,
      );
      if (!endpoint?.forwardUrl) return notFound(reply);
      if (
        !(await endpoints.redeliver(request.tenantId, request.params.eventId))
      ) {
        return notFound(reply);
      }
      void options.webhooks.deliverDue(request.log).catch(() => undefined);
      return reply.code(202).send();
    },
  };
}

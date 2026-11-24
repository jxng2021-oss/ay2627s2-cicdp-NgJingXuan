import type { Database } from "../db/client.js";
import type { WebhookEndpoint, WebhookEvent } from "../db/schema.js";
import {
  countEndpoints,
  deleteEndpoint,
  findTenantEndpoint,
  insertEndpoint,
  listEndpointEvents,
  listEndpoints,
  requeueEvent,
  updateEndpoint,
} from "../models/webhook.model.js";
import {
  BlockedTargetError,
  checkBaseUrl,
  type ProxyPolicy,
} from "./ssrf.service.js";

export const MAX_WEBHOOK_ENDPOINTS = 10;

export class WebhookSettingsError extends Error {}

export function checkForwardUrl(
  value: string | null | undefined,
  policy: ProxyPolicy,
): string | null | undefined {
  if (value === undefined || value === null) return value;
  try {
    return checkBaseUrl(value, policy).toString();
  } catch (error) {
    throw new WebhookSettingsError(
      error instanceof BlockedTargetError
        ? error.message.replace("baseUrl", "The delivery address")
        : "The delivery address isn't valid",
    );
  }
}

export function webhookEndpointService(db: Database, policy: ProxyPolicy) {
  return {
    list: (tenantId: string) => listEndpoints(db, tenantId),
    find: (tenantId: string, id: string) =>
      findTenantEndpoint(db, tenantId, id),

    async create(
      tenantId: string,
      input: {
        name: string;
        signingSecretName: string;
        forwardUrl: string | null;
      },
    ): Promise<WebhookEndpoint | "taken" | "too_many"> {
      const forwardUrl = checkForwardUrl(input.forwardUrl, policy) ?? null;
      if ((await countEndpoints(db, tenantId)) >= MAX_WEBHOOK_ENDPOINTS) {
        return "too_many";
      }
      const endpoint = await insertEndpoint(db, {
        tenantId,
        name: input.name,
        provider: "stripe",
        signingSecretName: input.signingSecretName,
        forwardUrl,
      });
      return endpoint ?? "taken";
    },

    update: (
      tenantId: string,
      id: string,
      input: { signingSecretName?: string; forwardUrl?: string | null },
    ) =>
      updateEndpoint(db, tenantId, id, {
        ...(input.signingSecretName === undefined
          ? {}
          : { signingSecretName: input.signingSecretName }),
        ...(input.forwardUrl === undefined
          ? {}
          : { forwardUrl: checkForwardUrl(input.forwardUrl, policy) ?? null }),
      }),

    remove: (tenantId: string, id: string) => deleteEndpoint(db, tenantId, id),

    events: (tenantId: string, id: string): Promise<WebhookEvent[]> =>
      listEndpointEvents(db, tenantId, id),

    redeliver: (tenantId: string, eventId: string) =>
      requeueEvent(db, tenantId, eventId),
  };
}

import type { FastifyBaseLogger } from "fastify";
import { Agent, request as sendRequest } from "undici";
import type { Database } from "../db/client.js";
import type { WebhookEndpoint, WebhookEvent } from "../db/schema.js";
import {
  claimDueEvents,
  findEndpoint,
  insertEvent,
  listEventsAfter,
  recordDelivery,
} from "../models/webhook.model.js";
import { pinnedLookup } from "./proxy.service.js";
import {
  BlockedTargetError,
  checkBaseUrl,
  hostOf,
  resolveAndCheck,
  type ProxyPolicy,
  type Resolver,
} from "./ssrf.service.js";
import {
  cleanStripeEvent,
  verifyStripeSignature,
  type CleanEventData,
} from "./stripe-webhook.service.js";
import type { WebhookSigner } from "./webhook-signing.service.js";

export const MAX_WEBHOOK_BYTES = 256 * 1024;
export const MAX_DELIVERY_ATTEMPTS = 10;
const LEASE_MS = 2 * 60_000;

export interface WebhookOptions {
  db: Database;
  signer: WebhookSigner;
  secretsUrl: string;
  policy: ProxyPolicy;
  resolver: Resolver;
  connectTimeoutMs: number;
  responseTimeoutMs: number;
}

export interface CleanEvent extends CleanEventData {
  id: string;
  endpointId: string;
}

export type ReceiveResult =
  | { status: "accepted"; event: WebhookEvent | undefined }
  | { status: "ignored" }
  | { status: "unauthorized" }
  | { status: "invalid" }
  | { status: "sealed" }
  | { status: "unavailable" };

export function cleanEvent(row: WebhookEvent): CleanEvent {
  return { id: row.id, endpointId: row.endpointId, ...row.data };
}

export function retryDelayMs(attempts: number): number {
  return Math.min(30_000 * 2 ** attempts, 60 * 60_000);
}

export function createWebhookService(options: WebhookOptions) {
  const secretsAgent = new Agent({
    connectTimeout: options.connectTimeoutMs,
    headersTimeout: options.responseTimeoutMs,
    bodyTimeout: options.responseTimeoutMs,
  });

  async function signingSecret(
    endpoint: WebhookEndpoint,
    requestId: string,
    clientIp: string,
  ): Promise<
    { value: string } | { problem: "sealed" | "missing" | "unavailable" }
  > {
    try {
      const response = await sendRequest(
        `${options.secretsUrl.replace(/\/$/, "")}/internal/secrets/${encodeURIComponent(endpoint.signingSecretName)}`,
        {
          dispatcher: secretsAgent,
          headers: {
            "x-tenant-id": endpoint.tenantId,
            "x-request-id": requestId,
            "x-client-ip": clientIp,
          },
        },
      );
      const body = (await response.body.json().catch(() => ({}))) as {
        value?: unknown;
        error?: { code?: string };
      };
      if (response.statusCode === 200 && typeof body.value === "string") {
        return { value: body.value };
      }
      if (response.statusCode === 404) return { problem: "missing" };
      if (body.error?.code === "SECRETS_SEALED") return { problem: "sealed" };
      return { problem: "unavailable" };
    } catch {
      return { problem: "unavailable" };
    }
  }

  async function receive(
    endpointId: string,
    rawBody: Buffer,
    signature: string | undefined,
    context: { requestId: string; clientIp: string; log: FastifyBaseLogger },
  ): Promise<ReceiveResult> {
    const endpoint = await findEndpoint(options.db, endpointId);
    if (!endpoint || !signature) return { status: "unauthorized" };
    const secret = await signingSecret(
      endpoint,
      context.requestId,
      context.clientIp,
    );
    if ("problem" in secret) {
      if (secret.problem !== "missing") return { status: secret.problem };
      context.log.warn(
        { endpointId, secretName: endpoint.signingSecretName },
        "webhook endpoint's signing secret doesn't exist",
      );
      return { status: "unauthorized" };
    }
    if (!verifyStripeSignature(rawBody, signature, secret.value)) {
      return { status: "unauthorized" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return { status: "invalid" };
    }
    const data = cleanStripeEvent(parsed);
    if (data === "invalid") return { status: "invalid" };
    if (data === "ignored") return { status: "ignored" };
    const event = await insertEvent(options.db, {
      endpointId: endpoint.id,
      tenantId: endpoint.tenantId,
      data,
      deliveryStatus: endpoint.forwardUrl ? "pending" : "pull",
      firstAttemptAt: endpoint.forwardUrl
        ? new Date(Date.now() + LEASE_MS)
        : null,
    });
    if (event?.deliveryStatus === "pending") {
      void deliver(event, endpoint, context.log).catch(() => undefined);
    }
    return { status: "accepted", event };
  }

  async function deliver(
    event: WebhookEvent,
    endpoint: WebhookEndpoint,
    log: FastifyBaseLogger,
  ): Promise<boolean> {
    const fail = async (error: string) => {
      const attempts = event.attempts + 1;
      await recordDelivery(options.db, event.id, {
        delivered: false,
        error,
        retryAt:
          attempts >= MAX_DELIVERY_ATTEMPTS
            ? null
            : new Date(Date.now() + retryDelayMs(attempts)),
      });
      log.warn(
        { webhookEventId: event.id, attempts, reason: error },
        "webhook delivery failed",
      );
      return false;
    };
    if (!endpoint.forwardUrl) return fail("no delivery address");
    let target: URL;
    let pinned: { address: string; family: 4 | 6 };
    try {
      target = checkBaseUrl(endpoint.forwardUrl, options.policy);
      pinned = await resolveAndCheck(
        hostOf(target),
        options.policy,
        options.resolver,
      );
    } catch (error) {
      return fail(
        error instanceof BlockedTargetError
          ? error.message
          : "the address could not be checked",
      );
    }
    const body = JSON.stringify(cleanEvent(event));
    const dispatcher = new Agent({
      connect: {
        lookup: pinnedLookup(pinned),
        timeout: options.connectTimeoutMs,
      },
      headersTimeout: options.responseTimeoutMs,
      bodyTimeout: options.responseTimeoutMs,
    });
    try {
      const response = await sendRequest(target, {
        dispatcher,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "secure-cloud-webhooks",
          "x-securecloud-event-id": event.id,
          "x-securecloud-signature": options.signer.sign(body),
        },
        body,
      });
      await response.body.dump();
      if (response.statusCode >= 200 && response.statusCode < 300) {
        await recordDelivery(options.db, event.id, { delivered: true });
        return true;
      }
      return await fail(`the dev app answered ${response.statusCode}`);
    } catch {
      return await fail("the dev app couldn't be reached");
    } finally {
      void dispatcher.destroy();
    }
  }

  async function deliverDue(log: FastifyBaseLogger): Promise<number> {
    const due = await claimDueEvents(options.db, LEASE_MS);
    let delivered = 0;
    for (const event of due) {
      const endpoint = await findEndpoint(options.db, event.endpointId);
      if (endpoint && (await deliver(event, endpoint, log))) delivered++;
    }
    return delivered;
  }

  async function pull(
    tenantId: string,
    after: number,
    limit: number,
    endpointId?: string,
  ) {
    const rows = await listEventsAfter(
      options.db,
      tenantId,
      after,
      limit,
      endpointId,
    );
    return {
      events: rows.map(cleanEvent),
      next: String(rows.at(-1)?.seq ?? after),
    };
  }

  return {
    receive,
    deliver,
    deliverDue,
    pull,
    close: () => secretsAgent.close(),
  };
}

export type WebhookService = ReturnType<typeof createWebhookService>;

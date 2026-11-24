import { createPublicKey, verify, type JsonWebKey } from "node:crypto";
import { SecureCloudError } from "./errors.js";
import type { Http } from "./http.js";

const KEY_CACHE_MS = 5 * 60_000;
const TOLERANCE_SECONDS = 300;

export interface WebhookEvent {
  id: string;
  endpointId: string;
  event: "payment.succeeded" | "payment.failed" | "refund.succeeded";
  provider: "stripe";
  providerEventId: string;
  orderId: string | null;
  amount: number | null;
  currency: string | null;
  paymentId: string | null;
  reason: string | null;
  occurredAt: string;
}

export interface VerifyOptions {
  endpointId?: string;
  toleranceSeconds?: number;
}

const EVENTS = new Set([
  "payment.succeeded",
  "payment.failed",
  "refund.succeeded",
]);

export class Webhooks {
  private keys?: { keys: (JsonWebKey & { kid?: string })[]; until: number };

  constructor(private readonly http: Http) {}

  async verify(
    rawBody: string | Buffer,
    signatureHeader: string | string[] | undefined,
    options: VerifyOptions = {},
  ): Promise<WebhookEvent> {
    const invalid = (why: string) =>
      new SecureCloudError(
        401,
        "INVALID_WEBHOOK_SIGNATURE",
        `This webhook can't be trusted: ${why}.`,
      );
    const header = Array.isArray(signatureHeader)
      ? signatureHeader[0]
      : signatureHeader;
    const match =
      /^t=([0-9]{1,12}),kid=([A-Za-z0-9_-]{1,64}),es256=([A-Za-z0-9_-]{40,200})$/.exec(
        header?.trim() ?? "",
      );
    if (!match) throw invalid("it has no X-SecureCloud-Signature");
    const [, t, kid, signature] = match;
    const body = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody;
    if (typeof body !== "string" || body === "") {
      throw invalid("pass the raw body, before JSON parsing");
    }
    const age = Math.abs(Date.now() / 1000 - Number(t));
    if (age > (options.toleranceSeconds ?? TOLERANCE_SECONDS)) {
      throw invalid("it is too old");
    }
    let jwk = (await this.publicKeys()).find((key) => key.kid === kid);
    jwk ??= (await this.publicKeys(true)).find((key) => key.kid === kid);
    if (!jwk) throw invalid("it wasn't signed by secure-cloud");
    const genuine = verify(
      "sha256",
      Buffer.from(`${t}.${body}`),
      {
        key: createPublicKey({ key: jwk, format: "jwk" }),
        dsaEncoding: "ieee-p1363",
      },
      Buffer.from(signature!, "base64url"),
    );
    if (!genuine) throw invalid("its signature is wrong");
    let event: WebhookEvent;
    try {
      event = JSON.parse(body) as WebhookEvent;
    } catch {
      throw invalid("it isn't JSON");
    }
    if (typeof event.id !== "string" || !EVENTS.has(event.event)) {
      throw invalid("it isn't a webhook event");
    }
    if (options.endpointId && event.endpointId !== options.endpointId) {
      throw invalid("it is for another webhook endpoint");
    }
    return event;
  }

  async events(
    options: { after?: string; endpointId?: string; limit?: number } = {},
  ): Promise<{ events: WebhookEvent[]; next: string }> {
    const query = new URLSearchParams();
    if (options.after) query.set("after", options.after);
    if (options.endpointId) query.set("endpointId", options.endpointId);
    if (options.limit) query.set("limit", String(options.limit));
    const search = query.size > 0 ? `?${query.toString()}` : "";
    return this.http.json(`/v1/webhook-events${search}`);
  }

  private async publicKeys(force = false) {
    if (!force && this.keys && this.keys.until > Date.now()) {
      return this.keys.keys;
    }
    const { keys } = await this.http.json<{
      keys: (JsonWebKey & { kid?: string })[];
    }>("/v1/webhooks/keys", { withKey: false });
    this.keys = { keys, until: Date.now() + KEY_CACHE_MS };
    return keys;
  }
}

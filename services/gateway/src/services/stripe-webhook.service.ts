import { createHmac, timingSafeEqual } from "node:crypto";

export const STRIPE_TOLERANCE_SECONDS = 300;

export type CleanEventName =
  "payment.succeeded" | "payment.failed" | "refund.succeeded";

export interface CleanEventData {
  event: CleanEventName;
  provider: "stripe";
  providerEventId: string;
  orderId: string | null;
  amount: number | null;
  currency: string | null;
  paymentId: string | null;
  reason: string | null;
  occurredAt: string;
}

export function verifyStripeSignature(
  rawBody: Buffer,
  header: string | undefined,
  signingSecret: string,
  nowMs = Date.now(),
): boolean {
  if (!header || header.length > 2048) return false;
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const at = part.indexOf("=");
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (name === "t" && /^[0-9]{1,12}$/.test(value)) timestamp = Number(value);
    if (name === "v1" && /^[0-9a-f]{64}$/.test(value)) signatures.push(value);
  }
  if (timestamp === undefined || signatures.length === 0) return false;
  if (Math.abs(nowMs / 1000 - timestamp) > STRIPE_TOLERANCE_SECONDS) {
    return false;
  }
  const expected = Buffer.from(
    createHmac("sha256", signingSecret)
      .update(`${timestamp}.`)
      .update(rawBody)
      .digest("hex"),
  );
  return signatures.some((signature) =>
    timingSafeEqual(Buffer.from(signature), expected),
  );
}

const text = (value: unknown, max = 200): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : null;
const whole = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;

type Json = Record<string, unknown>;
const object = (value: unknown): Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};

function idOf(value: unknown): string | null {
  return text(value) ?? text(object(value).id);
}

export function cleanStripeEvent(
  body: unknown,
): CleanEventData | "ignored" | "invalid" {
  const event = object(body);
  const providerEventId = text(event.id);
  const type = text(event.type);
  const created = whole(event.created);
  const data = object(object(event.data).object);
  if (!providerEventId || !type || created === null) return "invalid";
  const metadata = object(data.metadata);
  const base = {
    provider: "stripe" as const,
    providerEventId,
    occurredAt: new Date(created * 1000).toISOString(),
    currency: text(data.currency, 10),
    paymentId: idOf(data.payment_intent),
  };
  const sessionOrder =
    text(metadata.order_id) ?? text(data.client_reference_id);

  switch (type) {
    case "checkout.session.completed":
      if (data.payment_status !== "paid") return "ignored";
      return {
        ...base,
        event: "payment.succeeded",
        orderId: sessionOrder,
        amount: whole(data.amount_total),
        reason: null,
      };
    case "checkout.session.async_payment_succeeded":
      return {
        ...base,
        event: "payment.succeeded",
        orderId: sessionOrder,
        amount: whole(data.amount_total),
        reason: null,
      };
    case "checkout.session.async_payment_failed":
    case "checkout.session.expired":
      return {
        ...base,
        event: "payment.failed",
        orderId: sessionOrder,
        amount: whole(data.amount_total),
        reason: type.endsWith("expired") ? "expired" : "payment_failed",
      };
    case "charge.refunded":
      return {
        ...base,
        event: "refund.succeeded",
        orderId: text(metadata.order_id),
        amount: whole(data.amount_refunded),
        reason: data.refunded === true ? "full" : "partial",
      };
    default:
      return "ignored";
  }
}

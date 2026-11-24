import { viaConnection } from "./platform/client";

export const STRIPE_CONNECTION = "stripe";
export const CHECKOUT_SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;

const FORM = { "content-type": "application/x-www-form-urlencoded" };

export function shopUrl(): string {
  return (process.env.SHOP_URL ?? "http://localhost:3100").replace(/\/+$/, "");
}

export interface CheckoutOrder {
  orderId: string;
  slug: string;
  name: string;
  quantity: number;
  totalCents: number;
  shopper: { id: string; email: string };
}

export type StartResult =
  { ok: true; url: string; sessionId: string } | { ok: false; status: number };

export async function startCheckout(
  order: CheckoutOrder,
): Promise<StartResult> {
  const body = new URLSearchParams({
    mode: "payment",
    "payment_method_types[0]": "card",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "sgd",
    "line_items[0][price_data][unit_amount]": String(order.totalCents),
    "line_items[0][price_data][product_data][name]": `${order.quantity} x ${order.name}`,
    success_url: `${shopUrl()}/orders/complete?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${shopUrl()}/products/${order.slug}?payment=cancelled`,
    client_reference_id: order.orderId,
    customer_email: order.shopper.email,
    "metadata[order_id]": order.orderId,
    "metadata[shopper_id]": order.shopper.id,
    "metadata[slug]": order.slug,
    "metadata[quantity]": String(order.quantity),
    "payment_intent_data[metadata][order_id]": order.orderId,
  }).toString();
  const response = await viaConnection<{ id?: unknown; url?: unknown }>(
    STRIPE_CONNECTION,
    "POST /checkout/sessions",
    body,
    { headers: { ...FORM, "idempotency-key": order.orderId } },
  );
  const url: unknown = response.data?.url;
  const sessionId: unknown = response.data?.id;
  return response.ok &&
    typeof url === "string" &&
    url.startsWith("https://checkout.stripe.com/") &&
    typeof sessionId === "string" &&
    CHECKOUT_SESSION_ID.test(sessionId)
    ? { ok: true, url, sessionId }
    : { ok: false, status: response.status };
}

export interface PaidSession {
  orderId: string;
  shopperId: string;
  slug: string;
  quantity: number;
  totalCents: number;
  paymentId: string;
}

export type SessionResult =
  | { paid: true; session: PaidSession }
  | { paid: false; reason: "unpaid" | "unknown" };

const text = (value: unknown) => (typeof value === "string" ? value : "");

export async function checkoutResult(
  sessionId: string,
): Promise<SessionResult> {
  if (!CHECKOUT_SESSION_ID.test(sessionId)) {
    return { paid: false, reason: "unknown" };
  }
  const response = await viaConnection<Record<string, unknown>>(
    STRIPE_CONNECTION,
    `GET /checkout/sessions/${sessionId}`,
  );
  if (!response.ok) return { paid: false, reason: "unknown" };
  const data = response.data ?? {};
  const metadata = (data.metadata ?? {}) as Record<string, unknown>;
  if (data.payment_status !== "paid" || data.currency !== "sgd") {
    return { paid: false, reason: "unpaid" };
  }
  const session: PaidSession = {
    orderId: text(metadata.order_id),
    shopperId: text(metadata.shopper_id),
    slug: text(metadata.slug),
    quantity: Number(text(metadata.quantity)),
    totalCents: typeof data.amount_total === "number" ? data.amount_total : 0,
    paymentId: text(data.payment_intent),
  };
  return session.orderId && session.shopperId && session.paymentId
    ? { paid: true, session }
    : { paid: false, reason: "unknown" };
}

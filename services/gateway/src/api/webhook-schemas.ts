import { Type } from "typebox";
import {
  commonErrors,
  errorResponse,
  rateLimitHeaders,
  requestIdHeader,
  requiredHeader,
  SecretsErrorResponse,
  security,
} from "./schemas.js";

const tags = ["Webhooks"];

export const CleanEvent = Type.Object(
  {
    id: Type.String({
      format: "uuid",
      description: "secure-cloud's ID for this event: use it to ignore repeats",
    }),
    endpointId: Type.String({ format: "uuid" }),
    event: Type.Enum(
      ["payment.succeeded", "payment.failed", "refund.succeeded"],
      {
        description:
          "payment.succeeded: the customer paid. payment.failed: a slow payment failed, or the customer never paid (reason expired). refund.succeeded: a payment was refunded (reason full or partial).",
      },
    ),
    provider: Type.Enum(["stripe"]),
    providerEventId: Type.String({
      description: "Stripe's event ID (evt_...)",
    }),
    orderId: Type.String({
      nullable: true,
      description:
        "The order_id your dev app put in the payment's metadata (or client_reference_id)",
    }),
    amount: Type.Integer({
      nullable: true,
      description: "In the smallest unit (cents): paid, or refunded",
    }),
    currency: Type.String({ nullable: true }),
    paymentId: Type.String({
      nullable: true,
      description: "Stripe's PaymentIntent ID (pi_...)",
    }),
    reason: Type.String({ nullable: true }),
    occurredAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);

const EndpointParams = Type.Object(
  { endpointId: Type.String({ format: "uuid" }) },
  { additionalProperties: false },
);

const unauthorized = errorResponse(
  "UNAUTHORIZED: the Stripe-Signature header is missing, wrong or too old, or there is no such endpoint (always the same answer).",
  "UNAUTHORIZED",
  "The webhook signature is missing or wrong",
);

export const receiveWebhookSchema = {
  operationId: "receiveWebhook",
  tags,
  summary: "Where Stripe sends a webhook endpoint's events",
  description:
    "**For Stripe, not for your dev app. No API key:** Stripe signs each event with the endpoint's signing secret (`Stripe-Signature`), which secure-cloud checks with the secret kept in your vault. Payment and refund events become clean secure-cloud events, delivered to your dev app (signed with secure-cloud's private key, see `GET /v1/webhooks/keys`) or kept for `GET /v1/webhook-events`. Other events are acknowledged and ignored; repeats are ignored.",
  params: EndpointParams,
  response: {
    200: {
      description: "Received (or ignored)",
      headers: requestIdHeader,
      content: {
        "application/json": {
          schema: Type.Object(
            { received: Type.Boolean() },
            { additionalProperties: false },
          ),
        },
      },
    },
    400: errorResponse(
      "BAD_REQUEST: the body isn't a Stripe event.",
      "BAD_REQUEST",
      "The body isn't a Stripe event",
    ),
    401: unauthorized,
    413: errorResponse(
      "PAYLOAD_TOO_LARGE: over 256 KiB.",
      "PAYLOAD_TOO_LARGE",
      "Request body too large",
    ),
    429: errorResponse(
      "RATE_LIMITED: too many refused webhooks from this address.",
      "RATE_LIMITED",
      "Too many requests, try again later",
    ),
    503: errorResponse(
      "SECRETS_SEALED or SERVICE_UNAVAILABLE: the signing secret can't be read right now. Stripe retries.",
      "SECRETS_SEALED",
      "The secrets service is sealed until an operator unseals it",
      SecretsErrorResponse,
    ),
  },
};

const Jwk = Type.Object(
  {
    kty: Type.String(),
    crv: Type.String(),
    x: Type.String(),
    y: Type.String(),
    kid: Type.String(),
    alg: Type.Enum(["ES256"]),
    use: Type.Enum(["sig"]),
  },
  { additionalProperties: false },
);

export const webhookKeysSchema = {
  operationId: "getWebhookKeys",
  tags,
  summary: "secure-cloud's public keys for webhook events (JWKS)",
  description:
    "**No API key needed.** Every event secure-cloud sends to a dev app carries `X-SecureCloud-Signature: t=<unix time>,kid=<key ID>,es256=<signature>`: an ES256 signature (base64url, r||s) over `<t>.<raw body>` with secure-cloud's private key. Check it with the key whose `kid` matches, and refuse events older than 5 minutes. The SDK does this for you. Cacheable for 5 minutes.",
  response: {
    200: {
      description: "The public keys",
      headers: {
        ...requestIdHeader,
        "Cache-Control": requiredHeader(
          Type.String({ enum: ["public, max-age=300"] }),
        ),
      },
      content: {
        "application/json": {
          schema: Type.Object(
            { keys: Type.Array(Jwk) },
            { additionalProperties: false },
          ),
        },
      },
    },
  },
};

export const WebhookEventsQuery = Type.Object(
  {
    after: Type.Optional(
      Type.String({
        pattern: "^[0-9]{1,16}$",
        description:
          "`next` from the previous call; leave out to start from the beginning",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 100, default: 50 }),
    ),
    endpointId: Type.Optional(Type.String({ format: "uuid" })),
  },
  { additionalProperties: false },
);

export const listWebhookEventsSchema = {
  operationId: "listWebhookEvents",
  tags,
  summary: "Fetch new webhook events (pull)",
  description:
    "For a dev app secure-cloud can't reach (for example on localhost while secure-cloud is the live server): your webhook events, oldest first, after `after`. Keep `next` and pass it next time. The same events are pushed to dev apps that have a delivery address.",
  security,
  querystring: WebhookEventsQuery,
  response: {
    200: {
      description: "Events after the cursor",
      headers: rateLimitHeaders,
      content: {
        "application/json": {
          schema: Type.Object(
            { events: Type.Array(CleanEvent), next: Type.String() },
            { additionalProperties: false },
          ),
        },
      },
    },
    400: errorResponse(
      "BAD_REQUEST: an invalid cursor.",
      "BAD_REQUEST",
      "querystring/after must match pattern",
    ),
    ...commonErrors({ name: "the gateway", label: "Gateway" }),
  },
};

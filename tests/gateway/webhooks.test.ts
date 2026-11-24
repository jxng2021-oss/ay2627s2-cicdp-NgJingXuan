import {
  createHmac,
  createPublicKey,
  verify,
  type JsonWebKey,
} from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanStripeEvent } from "../../services/gateway/src/services/stripe-webhook.service.js";
import { Browser, fakeSecrets } from "./dashboard-helpers.js";
import {
  createTestDatabase,
  expectError,
  FakeAudit,
  startGateway,
} from "./helpers.js";

const WHSEC = "whsec_test_0123456789abcdefghijklmnopqrstuv";

let app: FastifyInstance;
let audit: FakeAudit;
let secrets: Awaited<ReturnType<typeof fakeSecrets>>;
let devApp: {
  server: Server;
  url: string;
  received: Received[];
  status: number;
};
let browser: Browser;
let workspace: string;

interface Received {
  headers: IncomingHttpHeaders;
  body: string;
}

async function startDevApp() {
  const received: Received[] = [];
  const state = { status: 200 };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      });
      res.statusCode = state.status;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${port}/webhooks/secure-cloud`,
    received,
    get status() {
      return state.status;
    },
    set status(value: number) {
      state.status = value;
    },
  };
}

beforeEach(async () => {
  const { db } = await createTestDatabase();
  audit = new FakeAudit();
  secrets = await fakeSecrets();
  devApp = await startDevApp();
  app = await startGateway({
    db,
    audit,
    secretsUrl: secrets.url,
    proxy: { allowedHosts: ["127.0.0.1"], allowPrivateTargets: true },
  });
  browser = new Browser(app);
  workspace = await browser.signUp(`owner-${Date.now()}@example.com`);
  await browser.request(
    "PUT",
    browser.ws(workspace, "/secrets/stripe-webhook"),
    {
      body: { value: WHSEC },
    },
  );
});

afterEach(() => {
  devApp.server.close();
});

async function createEndpoint(forwardUrl: string | null = devApp.url) {
  const response = await browser.request(
    "POST",
    browser.ws(workspace, "/webhooks"),
    {
      body: { name: "stripe", signingSecretName: "stripe-webhook", forwardUrl },
    },
  );
  expect(response.statusCode).toBe(201);
  return response.json<{ id: string; stripeUrl: string }>();
}

function stripeEvent(
  type: string,
  object: Record<string, unknown>,
  id = "evt_1",
) {
  return JSON.stringify({ id, type, created: 1_795_500_000, data: { object } });
}

const PAID_SESSION = {
  id: "cs_test_1",
  payment_status: "paid",
  amount_total: 3600,
  currency: "sgd",
  payment_intent: "pi_123",
  metadata: { order_id: "order-7" },
};

function stripeSignature(body: string, secret = WHSEC, at = Date.now()) {
  const t = Math.floor(at / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

function sendToSecureCloud(
  endpointId: string,
  body: string,
  signature?: string,
) {
  return app.inject({
    method: "POST",
    url: `/v1/webhooks/${endpointId}`,
    headers: {
      "content-type": "application/json",
      ...(signature === undefined ? {} : { "stripe-signature": signature }),
    },
    payload: body,
  });
}

async function delivered(count: number) {
  for (let i = 0; i < 100 && devApp.received.length < count; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return devApp.received;
}

async function publicKey(kid: string) {
  const keys = await app.inject({ method: "GET", url: "/v1/webhooks/keys" });
  expect(keys.headers["cache-control"]).toBe("public, max-age=300");
  const jwk = keys
    .json<{ keys: (JsonWebKey & { kid: string })[] }>()
    .keys.find((key) => key.kid === kid);
  expect(jwk).toBeDefined();
  return createPublicKey({ key: jwk!, format: "jwk" });
}

describe("webhook endpoints in the dashboard", () => {
  it("an owner creates one and gets the address to paste into Stripe", async () => {
    const endpoint = await createEndpoint();
    expect(endpoint.stripeUrl).toBe(
      `https://api.test/v1/webhooks/${endpoint.id}`,
    );
    const list = await browser.request(
      "GET",
      browser.ws(workspace, "/webhooks"),
    );
    expect(list.json()).toMatchObject({
      endpoints: [
        {
          id: endpoint.id,
          name: "stripe",
          provider: "stripe",
          forwardUrl: devApp.url,
        },
      ],
    });
    expect(audit.events.map((e) => e.action)).toContain(
      "webhook_endpoint.created",
    );
  });

  it("refuses a taken name and a delivery address that isn't allowed", async () => {
    await createEndpoint();
    expectError(
      await browser.request("POST", browser.ws(workspace, "/webhooks"), {
        body: {
          name: "stripe",
          signingSecretName: "stripe-webhook",
          forwardUrl: null,
        },
      }),
      409,
      "CONFLICT",
    );
    expectError(
      await browser.request("POST", browser.ws(workspace, "/webhooks"), {
        body: {
          name: "other",
          signingSecretName: "stripe-webhook",
          forwardUrl: "https://evil.example/hook",
        },
      }),
      400,
      "BAD_REQUEST",
    );
  });
});

describe("Stripe's webhooks through secure-cloud", () => {
  it("checks Stripe's signature, sends the clean event signed with secure-cloud's private key", async () => {
    const endpoint = await createEndpoint();
    const body = stripeEvent("checkout.session.completed", PAID_SESSION);

    const response = await sendToSecureCloud(
      endpoint.id,
      body,
      stripeSignature(body),
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });

    const [delivery] = await delivered(1);
    const event = JSON.parse(delivery!.body) as Record<string, unknown>;
    expect(event).toMatchObject({
      endpointId: endpoint.id,
      event: "payment.succeeded",
      provider: "stripe",
      providerEventId: "evt_1",
      orderId: "order-7",
      amount: 3600,
      currency: "sgd",
      paymentId: "pi_123",
    });
    expect(delivery!.body).not.toContain(WHSEC);
    expect(delivery!.headers["x-securecloud-event-id"]).toBe(event.id);

    const signature = String(delivery!.headers["x-securecloud-signature"]);
    const [, t, kid, es256] =
      /^t=([0-9]+),kid=([A-Za-z0-9_-]+),es256=([A-Za-z0-9_-]+)$/.exec(
        signature,
      )!;
    const key = await publicKey(kid!);
    const ok = verify(
      "sha256",
      Buffer.from(`${t}.${delivery!.body}`),
      { key, dsaEncoding: "ieee-p1363" },
      Buffer.from(es256!, "base64url"),
    );
    expect(ok).toBe(true);
    const forged = verify(
      "sha256",
      Buffer.from(`${t}.${delivery!.body.replace("3600", "1")}`),
      { key, dsaEncoding: "ieee-p1363" },
      Buffer.from(es256!, "base64url"),
    );
    expect(forged).toBe(false);
  });

  it("refuses missing, wrong and old signatures, and unknown endpoints (the same 401)", async () => {
    const endpoint = await createEndpoint();
    const body = stripeEvent("checkout.session.completed", PAID_SESSION);
    for (const signature of [
      undefined,
      "t=1,v1=nope",
      stripeSignature(body, "whsec_someone_else"),
      stripeSignature(body, WHSEC, Date.now() - 10 * 60_000),
    ]) {
      expectError(
        await sendToSecureCloud(endpoint.id, body, signature),
        401,
        "UNAUTHORIZED",
      );
    }
    expectError(
      await sendToSecureCloud(
        "00000000-0000-4000-8000-000000000000",
        body,
        stripeSignature(body),
      ),
      401,
      "UNAUTHORIZED",
    );
    expect(devApp.received).toEqual([]);
  });

  it("a repeated Stripe event is delivered once; other event types are acknowledged and dropped", async () => {
    const endpoint = await createEndpoint();
    const body = stripeEvent("checkout.session.completed", PAID_SESSION);
    await sendToSecureCloud(endpoint.id, body, stripeSignature(body));
    await sendToSecureCloud(endpoint.id, body, stripeSignature(body));
    const other = stripeEvent("customer.created", { id: "cus_1" }, "evt_2");
    expect(
      (await sendToSecureCloud(endpoint.id, other, stripeSignature(other)))
        .statusCode,
    ).toBe(200);

    await delivered(1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(devApp.received).toHaveLength(1);
    const events = await browser.request(
      "GET",
      browser.ws(workspace, `/webhooks/${endpoint.id}/events`),
    );
    expect(events.json<{ events: unknown[] }>().events).toHaveLength(1);
  });

  it("a dev app that is down gets the event again later", async () => {
    const endpoint = await createEndpoint();
    devApp.status = 500;
    const body = stripeEvent("checkout.session.completed", PAID_SESSION);
    await sendToSecureCloud(endpoint.id, body, stripeSignature(body));
    await delivered(1);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const listed = await browser.request(
      "GET",
      browser.ws(workspace, `/webhooks/${endpoint.id}/events`),
    );
    const [event] = listed.json<{
      events: {
        id: string;
        deliveryStatus: string;
        attempts: number;
        lastError: string;
      }[];
    }>().events;
    expect(event).toMatchObject({
      deliveryStatus: "pending",
      attempts: 1,
      lastError: "the dev app answered 500",
    });

    devApp.status = 200;
    const again = await browser.request(
      "POST",
      browser.ws(
        workspace,
        `/webhooks/${endpoint.id}/events/${event!.id}/redeliver`,
      ),
    );
    expect(again.statusCode).toBe(202);
    await delivered(2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const after = await browser.request(
      "GET",
      browser.ws(workspace, `/webhooks/${endpoint.id}/events`),
    );
    expect(
      after.json<{ events: { deliveryStatus: string }[] }>().events[0],
    ).toMatchObject({
      deliveryStatus: "delivered",
    });
  });

  it("without a delivery address the dev app pulls its events with its API key", async () => {
    const endpoint = await createEndpoint(null);
    const body = stripeEvent("charge.refunded", {
      id: "ch_1",
      amount_refunded: 1800,
      refunded: true,
      currency: "sgd",
      payment_intent: "pi_123",
      metadata: {},
    });
    await sendToSecureCloud(endpoint.id, body, stripeSignature(body));
    const key = (
      await browser.request("POST", browser.ws(workspace, "/api-keys"), {
        body: { name: "dev-app" },
      })
    ).json<{ key: string }>().key;

    const pull = (after?: string) =>
      app.inject({
        method: "GET",
        url: `/v1/webhook-events${after ? `?after=${after}` : ""}`,
        headers: { authorization: `Bearer ${key}` },
      });
    const first = await pull();
    expect(first.statusCode).toBe(200);
    const page = first.json<{
      events: Record<string, unknown>[];
      next: string;
    }>();
    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({
      event: "refund.succeeded",
      amount: 1800,
      paymentId: "pi_123",
      reason: "full",
      orderId: null,
    });
    expect((await pull(page.next)).json()).toEqual({
      events: [],
      next: page.next,
    });
    expect(devApp.received).toEqual([]);
  });
});

describe("Stripe events become clean events", () => {
  const event = (type: string, object: Record<string, unknown>) =>
    cleanStripeEvent(JSON.parse(stripeEvent(type, object)));

  it("payments that succeed, fail or expire, and refunds", () => {
    expect(event("checkout.session.completed", PAID_SESSION)).toMatchObject({
      event: "payment.succeeded",
      orderId: "order-7",
    });
    expect(
      event("checkout.session.completed", {
        ...PAID_SESSION,
        payment_status: "unpaid",
      }),
    ).toBe("ignored");
    expect(
      event("checkout.session.async_payment_succeeded", PAID_SESSION),
    ).toMatchObject({
      event: "payment.succeeded",
    });
    expect(
      event("checkout.session.async_payment_failed", PAID_SESSION),
    ).toMatchObject({
      event: "payment.failed",
      reason: "payment_failed",
    });
    expect(
      event("checkout.session.expired", {
        id: "cs_2",
        client_reference_id: "order-8",
        payment_intent: null,
      }),
    ).toMatchObject({
      event: "payment.failed",
      reason: "expired",
      orderId: "order-8",
    });
    expect(
      event("charge.refunded", {
        amount_refunded: 500,
        refunded: false,
        payment_intent: "pi_9",
      }),
    ).toMatchObject({
      event: "refund.succeeded",
      amount: 500,
      reason: "partial",
    });
    expect(event("invoice.paid", {})).toBe("ignored");
    expect(cleanStripeEvent({ type: "checkout.session.completed" })).toBe(
      "invalid",
    );
  });
});

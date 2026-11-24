import type { Metadata } from "next";
import { Code, Note, Params } from "@/components/docs/code";
import { NextPage } from "@/components/docs/docs-nav";

export const metadata: Metadata = { title: "Payment webhooks" };

export default function WebhooksDocsPage() {
  return (
    <>
      <header className="stack-2">
        <p className="eyebrow">SDK for Node.js</p>
        <h1 className="heading-3">Payment webhooks</h1>
        <p className="title-2">
          Learn when a Stripe payment succeeds, fails or is refunded, without
          handling Stripe&apos;s signing secret in your app.
        </p>
      </header>

      <h2 className="heading-5">How it works</h2>
      <ol>
        <li>
          Stripe sends its event to secure-cloud, which checks Stripe&apos;s
          signature with the whsec_ secret you saved in Secrets.
        </li>
        <li>
          secure-cloud turns it into a short event (payment.succeeded,
          payment.failed or refund.succeeded) and signs it with its own private
          key (ES256).
        </li>
        <li>
          Your server checks that signature with secure-cloud&apos;s public key,
          which the SDK fetches from <code>/v1/webhooks/keys</code> for you, and
          updates the order.
        </li>
      </ol>

      <h2 className="heading-5">Set it up</h2>
      <ol>
        <li>
          In Stripe (Developers, Webhooks) copy the signing secret, and save it
          in the dashboard&apos;s Secrets, for example as{" "}
          <code>stripe-webhook-secret</code>.
        </li>
        <li>
          In the dashboard&apos;s Webhooks page create an endpoint with that
          secret and your server&apos;s address, then paste its Stripe address
          into Stripe. Choose the events checkout.session.completed,
          checkout.session.async_payment_succeeded,
          checkout.session.async_payment_failed, checkout.session.expired and
          charge.refunded.
        </li>
        <li>
          When you create the Checkout session, put your order ID in its
          metadata as <code>order_id</code>: it comes back as{" "}
          <code>orderId</code>.
        </li>
      </ol>

      <h2 className="heading-5">Receive events</h2>
      <Code title="server.js">{`
const express = require("express");
const { SecureCloud } = require("@secure-cloud/sdk");

const cloud = new SecureCloud();
const app = express();

app.post(
  "/webhooks/secure-cloud",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    let event;
    try {
      event = await cloud.webhooks.verify(
        req.body,
        req.headers["x-securecloud-signature"],
        { endpointId: process.env.SECURE_CLOUD_WEBHOOK_ENDPOINT_ID },
      );
    } catch {
      return res.status(401).end();
    }
    if (event.event === "payment.succeeded") {
      await orders.markPaid(event.orderId, event.amount, event.paymentId);
    }
    res.json({ received: true });
  },
);

app.listen(3000);
`}</Code>
      <Note tone="warning">
        Pass the raw body, before JSON parsing: the signature covers the exact
        bytes. Answer with a 2xx quickly; anything else is sent again later.
      </Note>
      <Params
        rows={[
          [
            "webhooks.verify(rawBody, signature, options?)",
            "Promise<WebhookEvent>",
            "Checks the X-SecureCloud-Signature header (ES256, at most 5 minutes old) and returns the event. options.endpointId refuses events for other endpoints.",
          ],
          [
            "webhooks.events({ after?, endpointId? })",
            "Promise<{ events, next }>",
            "Pulls events with your API key, oldest first. Keep next and pass it as after the next time.",
          ],
        ]}
      />

      <h2 className="heading-5">The event</h2>
      <Params
        rows={[
          [
            "id",
            "string",
            "secure-cloud's event ID. The same event can arrive twice: skip IDs you have handled.",
          ],
          [
            "event",
            "string",
            "payment.succeeded, payment.failed or refund.succeeded.",
          ],
          [
            "orderId",
            "string | null",
            "The order_id you put in the Checkout session's metadata.",
          ],
          [
            "amount",
            "number | null",
            "In the smallest unit, like cents. For refunds, the total refunded so far.",
          ],
          ["currency", "string | null", "Like sgd."],
          [
            "paymentId",
            "string | null",
            "Stripe's payment ID (pi_...). Refunds are matched by it.",
          ],
          [
            "reason",
            "string | null",
            "payment_failed or expired for failures; full or partial for refunds.",
          ],
          ["occurredAt", "string", "When it happened at Stripe."],
        ]}
      />

      <h2 className="heading-5">Running on localhost</h2>
      <p>
        secure-cloud can&apos;t reach a server on your own computer. Create the
        endpoint without a delivery address and pull instead:
      </p>
      <Code title="sync.js">{`
let after = await loadPosition();
const { events, next } = await cloud.webhooks.events({ after });
for (const event of events) await handle(event);
await savePosition(next);
`}</Code>
      <p>
        To try it with real test payments, the Stripe CLI can forward
        Stripe&apos;s events to the endpoint&apos;s Stripe address:{" "}
        <code>stripe listen --forward-to &lt;Stripe address&gt;</code>. It
        prints its own whsec_ secret to save in Secrets.
      </p>

      <h2 className="heading-5">When something goes wrong</h2>
      <Params
        rows={[
          [
            "INVALID_WEBHOOK_SIGNATURE",
            "401",
            "From verify(): the signature is missing, wrong, too old, from an unknown key or for another endpoint. Answer 401 and ignore the request.",
          ],
          [
            "INVALID_API_KEY",
            "401",
            "From events(): the API key is wrong or revoked.",
          ],
        ]}
      />

      <NextPage current="/docs/webhooks" />
    </>
  );
}

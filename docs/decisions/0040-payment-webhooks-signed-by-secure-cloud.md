# 0040: Payment webhooks, checked by secure-cloud and signed with its own key

Date: 2026-11-24. Status: accepted. Jira: KAN-145.

## Context

Dev apps take payments with Stripe Checkout through a connection
(ADR 0039). They also need to know when a payment succeeds, fails or is
refunded, which Stripe reports with webhooks signed by a per-endpoint secret
(`whsec_...`). If every dev app checked Stripe's signature itself, it would
have to hold that secret, which is what secure-cloud exists to avoid.

## Decision

- Stripe sends its events to secure-cloud at `POST /v1/webhooks/{endpointId}`
  (no API key). The gateway reads the endpoint's signing secret through the
  internal secrets route (like the proxy, never cached, never returned) and
  checks `Stripe-Signature` (HMAC-SHA-256 over `t.body`, at most 5 minutes
  old, constant-time). An unknown endpoint, a missing secret and a bad
  signature all get the same 401; failed attempts count against the
  per-IP limit for failed keys. Bodies are limited to 256 KiB.
- secure-cloud turns the Stripe event into its own short event with its own
  names: `payment.succeeded` (`checkout.session.completed` when paid, and
  `async_payment_succeeded`), `payment.failed` (`async_payment_failed` and
  `expired`, reason `payment_failed` or `expired`) and `refund.succeeded`
  (`charge.refunded`, reason `full` or `partial`). Other types are
  acknowledged and dropped. Only IDs, amounts, the currency and the order ID
  from metadata are kept; never the customer's details or Stripe's body.
- Events are stored in the gateway's database (`webhook_events`, unique per
  endpoint and Stripe event ID, so Stripe's retries are stored once) and
  delivered in one of two ways:
  - **Push**, when the endpoint has a delivery address: a POST signed by
    secure-cloud, with the same SSRF checks as the proxy (allowlisted hosts,
    every resolved address checked, the checked address connected to, no
    redirects). Failures are retried after `min(30 s x 2^n, 1 h)`, at most 10
    attempts, by a loop in the gateway that claims due events with
    `FOR UPDATE SKIP LOCKED` and a 2 minute lease. Owners can send an event
    again from the dashboard.
  - **Pull**, without a delivery address (a dev app on localhost):
    `GET /v1/webhook-events?after=` with the API key.
- **Signing.** Instead of a shared secret per dev app, secure-cloud signs
  delivered events with one private key and publishes the public key at
  `GET /v1/webhooks/keys` (JWKS). The header is
  `X-SecureCloud-Signature: t=<unix>,kid=<key id>,es256=<base64url>` over
  `t.body`. We chose ES256 (P-256) rather than RS256: it is what user pools
  already use (ADR 0025), its keys and signatures are small, and Node's
  `crypto` does it natively. The SDK's `cloud.webhooks.verify()` fetches the
  public key (cached 5 minutes, fetched again for an unknown `kid`), checks
  the signature and age (5 minutes) and, optionally, the endpoint ID. A dev
  app never holds a secret to check webhooks.
- The private key is `WEBHOOK_SIGNING_KEY` (base64 PKCS#8 EC P-256). On the
  server it is required and `deploy.sh` generates it once with openssl
  (never printed). Locally it may be empty: the gateway makes a new key at
  start, and dev apps fetch the new public key.
- Endpoints are managed by owners in the dashboard (at most 10 per
  workspace) and audited on the tenant chain (`webhook_endpoint.created`,
  `.updated`, `.deleted`), which adds values to the public audit lists
  (recorded in `api/breaking-changes-allowed.txt`). Deleting a workspace
  deletes its endpoints and events (foreign keys).

## Consequences

- Stripe's secret stays in the vault; the dev app only needs the public key.
- Rotating `WEBHOOK_SIGNING_KEY` changes the `kid`; dev apps pick up the new
  key on the next unknown `kid`. There is no overlap period yet (key
  rotation is a later phase).
- The demo shop (local and CI only) receives pushed events at
  `/webhooks/secure-cloud`, verifies them with the SDK and updates its own
  orders (paid, failed, refunded); in live mode it pulls instead.
- Local testing with real Stripe events uses the Stripe CLI:
  `stripe listen --forward-to http://localhost:8080/v1/webhooks/<endpoint id>`,
  then save the `whsec_...` it prints as `STRIPE_WEBHOOK_SECRET` and run
  `pnpm demo:setup` again.

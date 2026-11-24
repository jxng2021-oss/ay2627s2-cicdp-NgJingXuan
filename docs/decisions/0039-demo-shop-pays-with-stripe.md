# 0039: The demo shop pays with Stripe (test mode)

- Status: Accepted
- Date: 2026-11-23
- Changes: the demo shop's checkout (ADR 0018) and connection amount
  limits (ADR 0019)

## Context

The demo shop's checkout paid a pretend payment API (`mock-upstream`,
`POST /charges` with JSON). The owner set up a Stripe account, proved a
payment through secure-cloud's proxy (`POST /v1/proxy/stripe/payment_intents`)
and asked for the pretend payments to go: the demo shop must pay with
Stripe. Stripe's API takes form bodies, and the amount limit only read JSON.

## Decision

- **Stripe Checkout (Stripe's hosted payment page):** Buy Now creates a
  Checkout Session through secure-cloud's `stripe` connection (base URL
  `https://api.stripe.com/v1`, the secret `stripe-secret-key` injected as
  `Authorization: Bearer`): card payments only, the order total in SGD
  cents as one line item, the shopper's email, metadata (order, shopper,
  product, quantity) and the order ID as `Idempotency-Key`. The customer
  is redirected to Stripe's page (only `https://checkout.stripe.com/`
  addresses are followed) and types the card there, so card details never
  reach the demo shop.
- **The demo shop's own database:** orders live in the demo shop's own
  Postgres (`demo-shop-db`, local and CI only, on a network only the demo
  shop joins, no port published), never in secure-cloud: secure-cloud is
  the middleman, not the dev app's database. Buy Now saves a pending order
  (product, quantity, catalog price, total, shopper) before redirecting;
  an order whose Checkout Session couldn't be created is deleted.
- **Coming back:** `/orders/complete?session_id=...` never trusts the link.
  It reads the session from Stripe through secure-cloud
  (`GET /checkout/sessions/{id}`, the ID checked first), requires
  `payment_status: paid`, then marks the order paid only if the order,
  the signed in shopper, the session and the amount all match, with
  Stripe's PaymentIntent ID. Doing it again returns the same paid order,
  so reloading never pays twice. Cancelling on Stripe's page returns to
  the product page.
- **No webhooks:** a customer who pays and closes the tab before Stripe
  sends them back has paid without an order. Stripe's
  `checkout.session.completed` webhook would close that gap later.
- **Test mode only:** `pnpm demo:setup` reads `STRIPE_SECRET_KEY` (root
  `.env` or the environment), refuses anything but a `sk_test_`/`rk_test_`
  key, stores it in the vault and never prints it. CI uses the GitHub
  secret `STRIPE_TEST_SECRET_KEY`, so the demo shop's browser tests fill in
  Stripe's real test payment page. The local gateway allows
  `api.stripe.com`.
- **Amount limits read form bodies too:** for
  `application/x-www-form-urlencoded`, the amount field must appear exactly
  once and be a whole positive number (digits only), or the call is refused
  before the secret is read. Two copies are refused because secure-cloud
  and the provider might read different ones. The field may use form-style
  brackets, like Stripe Checkout's `line_items[0][price_data][unit_amount]`.
- **The connection's policy:** only `POST /checkout/sessions` and
  `GET /checkout/sessions/*`, at most S$500 a call and S$2,000 a day, 40
  calls a minute.
- `mock-upstream` stays, but only as test equipment for secure-cloud's own
  proxy, policy and SDK tests. No dev app pays through it.

## Consequences

- CI needs the `STRIPE_TEST_SECRET_KEY` secret and outbound HTTPS to Stripe;
  without the secret, `demo:setup` stops with a clear message.
- Payments made by the demo shop show in the Stripe dashboard (Test mode).
- The daily amount limit (S$2,000) also caps how much the browser tests can
  pay in a day through one workspace.

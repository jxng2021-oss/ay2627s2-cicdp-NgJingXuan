# The demo shop against the local stack or the live server

The demo shop is a pretend customer (ADR 0018). It always runs on your own
machine and only uses the public `/v1` API with an API key that stays on
your machine. One setting chooses which platform it talks to:

```
DEMO_SHOP_TARGET=local   browser → shop (localhost:3100) → gateway 127.0.0.1:8080   (dashboard http://localhost:3000)
DEMO_SHOP_TARGET=live    browser → shop (localhost:3100) → https://api.<domain>/v1   (dashboard https://<domain>)
```

Put it in the root `.env` (copy the line from `.env.example`), or set it for
one command. Then:

```sh
pnpm demo:start   # starts the shop against DEMO_SHOP_TARGET
pnpm demo:stop    # stops it, whichever target it was using
```

Each target keeps its own settings in `.local/` (git-ignored, never commit
them): `.local/demo-shop.env` for local, `.local/demo-shop-live.env` for
live. Switching targets never mixes their keys.

## What it exercises

| Shop feature                     | Platform feature                                  |
| -------------------------------- | ------------------------------------------------- |
| Shopper sign up, sign in, orders | User pools (ES256 tokens, refresh, roles)         |
| Choose a new password            | An owner's password reset (passwordResetRequired) |
| Sale banner                      | Feature flags (`sale-banner`, production)         |
| Product photos                   | Encrypted file storage                            |
| Checkout payment (Stripe)        | Proxy connection with the secret injected         |
| Paid, failed and refunded orders | Payment webhooks signed by secure-cloud (ES256)   |
| Admin → Activity                 | Audit events                                      |

## Payments: Stripe in test mode

Checkout uses **Stripe Checkout** in test mode (no real money):

1. **Buy Now:** the demo shop asks secure-cloud's `stripe` connection for a
   Checkout Session (`POST /checkout/sessions`); secure-cloud adds the
   Stripe key from the vault (the secret `stripe-secret-key`), so the demo
   shop never holds it. The order's ID is the idempotency key.
2. The customer is sent to **Stripe's payment page** and types the card
   there (test card `4242 4242 4242 4242`, any future date and CVC;
   `4000 0000 0000 0002` is declined). Card details never reach the demo
   shop.
3. Stripe sends the customer back to `/orders/complete?session_id=...`. The
   demo shop doesn't trust that link: it asks Stripe, through secure-cloud
   (`GET /checkout/sessions/{id}`), whether the session is paid and belongs
   to the signed in shopper, then marks the order paid once (reloading
   never pays twice).
4. Leaving Stripe's page returns to the product with "Payment cancelled".

The connection only allows those two routes and refuses orders over S$500
(S$2,000 a day) before the key is used: the order total is the session's
single line item, `line_items[0][price_data][unit_amount]`. Payments show
in the Stripe dashboard (Test mode, Payments).

## Webhooks: payments the customer doesn't come back from

A customer who pays and closes the tab never reaches step 3, and refunds
happen later in the Stripe dashboard. Stripe reports both with webhooks, and
secure-cloud is the middleman for those too (docs/decisions/0040):

1. Stripe sends its event to secure-cloud's endpoint for the shop
   (`/v1/webhooks/<endpoint id>`), which checks Stripe's signature with the
   `whsec_...` secret in the vault (`stripe-webhook-secret`).
2. secure-cloud sends a short event (`payment.succeeded`, `payment.failed`,
   `refund.succeeded`) to the shop's `/webhooks/secure-cloud`, signed with
   secure-cloud's private key.
3. The shop checks it with the SDK (`cloud.webhooks.verify`, using
   secure-cloud's public key) and marks the order paid, failed or refunded.
   Each event is handled once.

`pnpm demo:setup` creates the endpoint. To send it real test events, run the
[Stripe CLI](https://docs.stripe.com/stripe-cli):
`stripe listen --forward-to http://localhost:8080/v1/webhooks/<endpoint id>`
(setup prints the command), put the `whsec_...` it prints in the root `.env`
as `STRIPE_WEBHOOK_SECRET` and run `pnpm demo:setup` again. In live mode the
deployed secure-cloud can't reach this computer, so the shop pulls its
events (`cloud.webhooks.events`) whenever it shows orders; set
`PLATFORM_WEBHOOK_ENDPOINT_ID` in `.local/demo-shop-live.env` to the
endpoint's ID from the dashboard.

Your Stripe test key (Stripe dashboard, Test mode, Developers, API keys:
`sk_test_...`) goes in the root `.env` as `STRIPE_SECRET_KEY` (git-ignored).
`demo:setup` refuses live keys. CI uses the GitHub secret
`STRIPE_TEST_SECRET_KEY`.

## Orders: the demo shop's own database

secure-cloud is only the middleman: the demo shop keeps its **orders in its
own Postgres database** (`demo-shop-db`, local and CI only). Only the demo
shop is on its network and no port is published, so neither secure-cloud
nor the host can read it. Buy Now saves a **pending** order before sending
the customer to Stripe; Stripe's confirmation turns it **paid**, with
Stripe's payment ID. An order whose payment page never opened (for example
one over S$500, refused by secure-cloud) is deleted. Webhooks can also turn
an order **failed** (expired or declined) or **refunded**. My Orders lists
the shopper's paid and refunded orders; Admin, Orders lists every order with its status.
The table is created on first use (`apps/demo-shop/src/lib/orders.ts`).
To look inside:

```sh
docker compose exec demo-shop-db psql -U shop -d shop -c "select * from orders"
```

## Local

Start and unseal the local stack, then let the setup script create the shop's
workspace, key, pool, flag, Stripe secret and connection:

```sh
pnpm local:start
LOCAL_DEV_MODE=true pnpm local:secrets:unseal
LOCAL_DEV_MODE=true pnpm demo:setup
pnpm demo:start
```

## Live

1. In the live dashboard, as a workspace owner:
   - **API keys:** create `demo-shop server` and copy it (shown once);
   - **User pools → Users:** create `Shop customers`; copy its ID;
   - **Flags:** create `sale-banner` (boolean, off value false); in
     `production` turn it on with default value true.
2. Set `DEMO_SHOP_TARGET=live` and run `pnpm demo:start`. The first run
   writes `.local/demo-shop-live.env` and stops: fill in `PLATFORM_API_KEY`
   and `PLATFORM_POOL_ID` (the API address comes from
   `DEMO_SHOP_LIVE_API_URL`) and run it again.
3. It checks the live platform (ready, key, pool, vault unsealed, flag),
   builds the shop image and starts it at http://localhost:3100.
   `SHOP_ADMIN_PASSWORD` in the same file opens http://localhost:3100/admin.

Checkout on the live server also needs:

- `api.stripe.com` in the `PROXY_ALLOWED_HOSTS` GitHub variable (then
  redeploy);
- in the live dashboard, **Secrets:** `stripe-secret-key` with your
  `sk_test_...` key, and **Connections:** `stripe`, base URL
  `https://api.stripe.com/v1`, secret `stripe-secret-key`, header
  `Authorization`, prefix `Bearer ` (optionally the policy: only
  `POST /checkout/sessions` and `GET /checkout/sessions/*`, amount field
  `line_items[0][price_data][unit_amount]`, at most 50000 a call and
  200000 a day). Set `SHOP_URL` if the shop isn't at http://localhost:3100.

Without them everything else works and checkout reports a payment error.

When you are done with live, revoke the `demo-shop server` key in the
dashboard.

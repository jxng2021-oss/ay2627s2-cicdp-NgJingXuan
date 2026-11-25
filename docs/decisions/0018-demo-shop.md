# 0018: A demo shop as a pretend customer

- Status: Accepted; the demo shop pays with Stripe ([0039](0039-demo-shop-pays-with-stripe.md)) and receives payment webhooks ([0040](0040-payment-webhooks-signed-by-secure-cloud.md))
- Date: 2026-11-12

## Context

Every platform feature is tested on its own, but nothing showed a real
app using them together, the way a customer would: with only an API key and
the public `/v1` API. The owner asked for a demo app to prove the platform
works, with the same stack and design as the dashboard. It is a prototype
with a deadline, so it must stay small, local and isolated from the product.

## Decisions

### A local-only Next.js app, `apps/demo-shop`

- A shop with four fixed products, a checkout, receipts and an admin area,
  on http://localhost:3100. Same stack and design as the dashboard
  (design.md); `globals.css` is a copy of the dashboard's tokens and
  component classes, with shop-only layout in `shop.css`.
- **Local development and CI only, like `tools/mock-upstream`:** it runs in
  the root `docker-compose.yml`, is built and tested in CI, and is never in
  `deploy/`, ECR or the deployment workflows. Its image isn't in the image
  scan for the same reason as the mock's.
- It is a **customer, not part of the platform**: it never uses the
  dashboard API, internal routes or other services' databases.

### The API key stays on the shop's server

The shop's pages are Server Components, its checkout is a Server Action and
its photo and upload endpoints are Route Handlers, so every platform call
runs on the shop's server (`src/lib/platform/client.ts`) with
`PLATFORM_API_KEY` from its environment. Browsers only talk to the shop
(its CSP's `connect-src` is `'self'`). This is how a real customer must use
an API key, and the opposite of the dashboard, which uses session cookies
from the browser (ADR 0017).

The client's types are generated from the public spec,
`api/openapi.v1.json`, by `pnpm api:generate` and checked by
`pnpm api:check`, as any customer's generated client would be.

### What the shop uses, and why

| Feature                      | Used for                                                                                                                                                                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Encrypted storage            | Product photos (`product-<slug>.<ext>`) and receipts (`receipt-<order>.json`). The shop has no database: these files are its only saved state.                                                                                                        |
| Proxy connection (injection) | Checkout calls a pretend payment provider through `/v1/proxy/payments/charges`; the platform injects the payment key. The shop never has it.                                                                                                          |
| Secrets                      | `payment-api-key`, write-only: the shop never reads it; the platform injects it into payments. (A receipt-signing secret was dropped when secrets became write-only, ADR 0021: storage's authenticated encryption already detects a changed receipt.) |
| Audit log                    | The admin's Activity page lists `GET /v1/audit-events`: each payment, secret read and file, with its request ID.                                                                                                                                      |

- The **pretend payment provider** is a new route on `tools/mock-upstream`
  (`POST /api/payments/charges`): it checks the injected
  `Authorization: Bearer <MOCK_PAYMENT_API_KEY>` (a fake, local-only value),
  answers 201 with a charge, and 402 above S$1,000.00 so a declined payment
  can be shown.
- **Downloads are always `application/octet-stream`** (a platform rule), so
  the shop takes a file's real type and name from its metadata. The photo
  route serves only product photos (PNG, JPEG or WebP, named `product-*`)
  with `nosniff`; any other file is a 404, so it can't be used to read
  receipts. Receipts are only read if named `receipt-*.json` and under
  64 KiB.
- Uploads are streamed from the browser through a Route Handler to the
  platform, with the size counted while streaming (5 MB). Because the
  browser sends the admin login automatically, the upload route also
  requires a custom header and a same-origin `Origin`, so other sites can't
  forge an upload.
- Prices come only from the server's catalog, never from the form.

### Setup through the real APIs: `pnpm demo:setup`

`LOCAL_DEV_MODE=true pnpm demo:setup` (`scripts/demo-shop-setup.ts`) signs up
a throwaway owner through the dashboard API, creates the shop's API key, and
then, with that key, saves the two secrets and creates the `payments`
connection through `/v1`. It writes `PLATFORM_API_KEY` and a random
`SHOP_ADMIN_PASSWORD` to the git-ignored `.local/demo-shop.env` (read by the
container through an optional `env_file`) and restarts the shop. It prints
no secret values, so it can run in CI. The seed script and this setup share
`scripts/dashboard-session.ts`.

### Admin

`/admin` needs the admin password (`SHOP_ADMIN_PASSWORD`), typed into the
shop's own sign in page, `/admin-login` (it was HTTP Basic, whose browser
popup the owner asked to replace, 2026-11-16). The password is compared in
constant time; a signed in admin gets an HttpOnly, SameSite=Strict
`shop_admin` cookie (its expiry, 8 hours, signed with an HMAC keyed by the
password, so a new password signs everyone out), checked in
`src/proxy.ts`, which sends anyone else to the sign in page. Without a
password, admin is off. Demo-grade on purpose: the platform's own accounts
are the dashboard's.

## Consequences

- `pnpm test:demo` (Playwright) runs in the CI e2e job after `pnpm
demo:setup` and before the dashboard's tests (which seal the secrets
  service at the end): photo upload and display, checkout and a verified
  receipt, a declined payment, the audit trail, refused forged uploads and
  non-images, and axe on the shop pages.
- A paid order whose receipt then fails to save isn't refunded or retried:
  out of scope for a demo, noted in the code.
- The shop's copy of the design tokens must be kept in sync with the
  dashboard's by hand.

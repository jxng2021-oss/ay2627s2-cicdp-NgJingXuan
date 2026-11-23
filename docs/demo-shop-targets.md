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
| Product photos, receipts         | Encrypted file storage                            |
| Checkout payment                 | Proxy connection with the secret injected         |
| Admin → Activity                 | Audit events                                      |

## Local

Start and unseal the local stack, then let the setup script create the shop's
workspace, key, pool, flag, secret and connection:

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

Checkout on the live server also needs a payment API on the internet, its
host in the `PROXY_ALLOWED_HOSTS` GitHub variable (then redeploy), a
`payment-api-key` secret and a `payments` connection. Without them
everything else works and checkout reports a payment error.

When you are done with live, revoke the `demo-shop server` key in the
dashboard.

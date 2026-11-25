# 0017: The dashboard frontend

- Status: Accepted; the Reveal button superseded by [0021](0021-write-only-secrets.md) (secret values are write-only); the look and the landing page updated by [0022](0022-hashicorp-style-ui.md)
- Date: 2026-11-12

## Context

The dashboard API (`/dashboard/v1`, [ADR 0016](0016-dashboard-auth.md)) is
built. People now need a web interface for it: sign up and log in, and a
workspace's API keys, secrets, files, connections and audit log. The design
system to follow is `design.md` in the repository root ("Executor"). Out of
scope: billing, invites, threat detection, access policies, marketing pages
and a demo app. No backend features, except small fixes an existing flow
needs.

## Decisions

### Next.js (App Router), in `apps/dashboard`

- Next.js 16 with the App Router, React 19 and strict TypeScript, as a new
  pnpm workspace package (`@platform/dashboard`) under `apps/`, linted and
  formatted with the repository's ESLint and Prettier settings.
- Pages are client components that call the API from the browser. The
  Next.js server only renders the page shell and sets the security headers;
  it never sees a session token, password, API key or secret value.
- Built with `output: "standalone"`: the Docker image contains only the
  server and the files it needs, runs as the non-root `node` user with a
  read-only filesystem, no capabilities and no npm.

### The browser calls the gateway directly (CORS), not through Next.js

The browser loads the pages from the dashboard (`localhost:3000`) and calls
the gateway's dashboard API (`localhost:8080/dashboard/v1`) itself, with
`credentials: "include"`. The gateway's CORS rule (ADR 0016) already allows
exactly `DASHBOARD_ORIGIN` with credentials; the session cookie
(`SameSite=Lax`, `Path=/dashboard`) is sent because the two are on the same
site.

Rejected: forwarding API calls through Next.js (rewrites or middleware),
which would have made every call same-origin. Measured problems:

- Next.js keeps a client-sent `X-Forwarded-For`. The gateway would have to
  trust the dashboard as a proxy (`TRUST_PROXY`) to see real client IPs, and
  then a client could pick its own IP and get around the per-IP sign-up and
  login limits. Without trusting it, every user shares the dashboard
  container's IP and one user's failed logins block everyone.
- A fixed 30-second proxy timeout (large uploads fail) and request bodies
  buffered in memory (breaks "stream file bodies").

The gateway's address is a runtime setting, `DASHBOARD_API_ORIGIN`, read by
the server when it renders the page and handed to the browser, and also
used for the CSP's `connect-src`. One image runs unchanged in every
environment; nothing is baked in at build time.

### One small API client, with generated types

- `src/lib/api/schema.d.ts` is generated from `api/openapi.dashboard.json`
  with `openapi-typescript` by `pnpm api:generate`; `pnpm api:check` (the
  `api-spec` CI job) fails if it is out of date. Every request and response
  type in the client comes from it.
- `src/lib/api/client.ts` is the only code that talks to the API. It always
  sends the cookie (`credentials: "include"`, `cache: "no-store"`), fetches
  the CSRF token after sign-in and adds it to every change (keeping it only
  in memory and fetching a new one once on a CSRF `403`), turns the error
  format into an `ApiError` with the code, message and request ID, and
  reports a `401` on a signed-in page as "session ended".
- Uploads use `XMLHttpRequest` (for upload progress), streaming the file
  from disk; downloads are plain links, so the browser streams them to disk.
- The gateway exposes `X-Request-Id` and `Retry-After` to the dashboard's
  origin (`Access-Control-Expose-Headers`), the only backend change: without
  it the browser hides the request ID that unexpected errors show.

### Sessions and routing

- Workspace pages load the user and the workspace first. Not signed in:
  redirect to `/login?next=<the page>`. Not a member, or no such workspace:
  the same "Page not found" (the API answers both with the same 404).
- `next` is only followed if it matches an allowlist of the dashboard's own
  paths (`/workspaces/<id>[/<section>]` or `/account`), so login can't be
  used as an open redirect.
- A session that ends while a page is open (idle or absolute timeout,
  logged out elsewhere, password changed) shows "Session Ended" with a
  link back to login that returns to the same page.

### Sensitive data

- A new API key is shown once, in a monospace block with a copy button and
  a warning, then forgotten. Secret values are only fetched when an owner
  clicks Reveal (an audited route) and hidden again after 15 seconds.
- Nothing is written to `localStorage`, `sessionStorage` or URLs, and there
  are no analytics. The browser tests check storage and URLs after showing
  a key and a secret.
- No `dangerouslySetInnerHTML` anywhere. Filenames, secret names and audit
  data are rendered as text by React; a test uploads a file named like an
  HTML tag with a script and checks it is shown as text and nothing runs.
- Security headers: a Content Security Policy with a new nonce per request
  and `'strict-dynamic'` for scripts, `connect-src` limited to the page and
  the API origin, `frame-ancestors 'none'`, `object-src 'none'`,
  `base-uri 'self'`, `form-action 'self'`; plus `nosniff`,
  `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, a strict
  `Permissions-Policy` and `Cross-Origin-Opener-Policy`. Pages are rendered
  per request (the nonce needs it). Styles allow `'unsafe-inline'`, needed
  for React `style` attributes; no user data is ever placed in a style.
- Fonts are self-hosted (the `geist` package), so the CSP needs no
  third-party origins.
- Role-based controls are hidden (members don't see Create, Rotate, Reveal,
  Revoke or Delete), but every permission is still enforced by the API; the
  browser tests check a member really can't see them.

### Design

All values from `design.md` live once, as CSS custom properties in
`src/app/globals.css` (colours for light and dark, the type scale, 4px
spacing, radii, motion durations), and the shared components (`Button`,
`Field`, `Card`, `Status`, `Banner`, `Dialog`, `ConfirmDialog`, tables) in
`src/components/ui.tsx` use only those. Navigation is one array
(`src/lib/nav.ts`), so a new page is one line.

Where `design.md` was interpreted or didn't cover something (the simplest
consistent choice):

- **Product, not Executor.** `design.md` describes "Executor"; the wordmark
  here is `secure-cloud` in Geist Mono, as its rules ask. The marketing,
  docs and illustration sections don't apply.
- **Plain CSS, not Tailwind and shadcn.** `design.md` describes its own
  source files (Tailwind `@theme`, shadcn components). The same tokens,
  variants on `data-*` attributes, radii, focus ring and disabled opacity
  are written as plain CSS, with no extra dependencies.
- **Mobile.** `design.md` only requires 768px and up. Below that the
  sidebar becomes a menu button and tables become stacked cards (each cell
  labelled), because the task needs every page on mobile.
- **Fonts self-hosted** instead of Google Fonts, for the CSP.
- **Dark mode** follows the system setting (`prefers-color-scheme`); there's
  no toggle.
- **Dialogs** are the native `<dialog>` element (focus moves in, Escape
  closes, focus returns), styled as `design.md`'s overlay surface.
- **No icons.** `design.md` forbids icon packs; status uses a dot and a
  word, actions use text buttons.
- **Status chips.** Grayscale with a dot and a word ("Active", "Revoked",
  "Unsealed", "Sealed"); only destructive and error states use the one red,
  so status is never shown by colour alone.
- **Toasts** appear at the bottom right, in the
  sentence-case, no-"successfully" style `design.md` sets.
- **Sealed banner.** A full-width banner on every workspace page, saying
  which actions are unavailable until the secrets service is unsealed.

### Tests

- Unit tests (Vitest, jsdom, Testing Library) for the API client (cookies,
  CSRF token and retry, error format, request IDs, session end), the error
  and confirmation components, and the login/sign-up form's validation.
- Browser tests (Playwright, Chromium) against the full Compose stack:
  sign-up, login, logout and an ended session; API keys; secrets (reveal,
  auto-hide, rotate, versions, delete); files (upload progress, download,
  delete, a script-like name); connections; the matching audit events and
  filters; a member's view; another user's workspace; the sealed banner;
  axe (WCAG 2.1 AA) on every main page at desktop and mobile sizes; and
  keyboard use of dialogs. Accounts and values are generated per run. In CI
  they run in the `e2e` job, and traces and screenshots are uploaded only
  when a test fails.

## Consequences

- One more image (`dashboard`) is built, scanned, pushed and deployed by
  digest with the others; ECR gets a `dashboard` repository and the
  security group opens port 3000 to `allowed_cidr` (same rule as the
  gateway's port).
- Deployed, the dashboard needs `DASHBOARD_ORIGIN` and
  `DASHBOARD_API_ORIGIN` set to real HTTPS origins on the same site. Until a
  domain and TLS exist (a load balancer is a later phase), deploy.sh uses
  `.invalid` placeholders: the page loads but nobody can sign in.
- Locally the dashboard must be opened as `http://localhost:3000`, not
  `127.0.0.1`, because the gateway only allows that exact origin and the
  cookie needs the same site.
- Grafana moved to `127.0.0.1:3001` locally, to free port 3000.
- Changing the dashboard API now needs `pnpm api:generate`, which updates
  the types; type errors then show what the frontend must change.

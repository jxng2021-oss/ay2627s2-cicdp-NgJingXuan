# 0016: Dashboard accounts, sessions and CSRF protection

- Status: Accepted; the owner-only reveal route superseded by [0021](0021-write-only-secrets.md) (secret values are write-only); sessions now use short access tokens with silent server-side refresh ([0024](0024-silent-refresh.md)); sessions renew for 30 days while in use ([0037](0037-dashboard-sessions-30-day-refresh.md)); Continue with Google or GitHub added ([0038](0038-dashboard-google-github-sign-in.md))
- Date: 2026-11-05

## Context

The next step is a web dashboard. People need accounts, workspaces they
share, and a backend API built for a browser. The temporary shared
`ADMIN_TOKEN` must go. Out of scope: the frontend itself, email (so no
verification, reset emails or invites), MFA, SSO and billing.

## Decisions

### Users, workspaces and roles

In the gateway's database: `users` (normalised email, Argon2id hash,
status), `memberships` (user, tenant, role) and `sessions`. An existing
**tenant is a workspace**. Sign-up creates the user, a workspace and an
owner membership in **one transaction**.

Two roles, checked on the server for every route:

|                                                                  | owner | member |
| ---------------------------------------------------------------- | :---: | :----: |
| View the overview, metadata, versions, connections, audit events |   ✔   |   ✔    |
| Upload and download files                                        |   ✔   |   ✔    |
| Create and revoke API keys                                       |   ✔   |        |
| Create, rotate, delete and **reveal** secrets                    |   ✔   |        |
| Create and delete proxy connections; delete files                |   ✔   |        |

Every workspace route checks, in order: the session, the membership (a
workspace you don't belong to is the **same 404** as one that doesn't
exist), then the role (403). The tenant comes only from the verified
membership, never from a body or header. Without invites, a local command
adds members for testing.

### Passwords

- **Argon2id** (`@node-rs/argon2`, prebuilt, no install scripts) with
  OWASP's minimum: **19 MiB memory, 2 passes, 1 thread**, a random 16-byte
  salt per hash, settings stored in each hash so they can be raised later.
- 12 to 128 characters (the maximum keeps hashing cheap), and a short list
  of common passwords is refused.
- Login gives the **same 401 and message** for a wrong password, an unknown
  email and a disabled account. For an unknown email, the password is
  checked against a dummy hash, so it takes as long as a real check.
- Strict rate limits (Redis) on sign-up, login and password changes, per IP
  and per email (stored as a hash). Without Redis these are refused (503)
  rather than unlimited.
- Never logged, returned or put in audit events. Without email, an operator
  command sets a new random password (shown once) and ends every session.
- Sign-up with a taken email answers 409, which tells the caller the
  account exists; without email verification there is no way round that.
  The per-email and per-IP limits keep it slow.

### Sessions: cookies, not tokens in JavaScript

A session token is 32 random bytes (256 bits); only its **SHA-256** is
stored. It travels in a cookie that is:

- **HttpOnly**: page scripts (and so any XSS) can't read it;
- **SameSite=Lax**: browsers don't send it with cross-site POSTs, form
  submissions or fetches;
- **Secure** everywhere except local development over plain http (refused
  with `NODE_ENV=production`), named `__Secure-scp_session` so browsers
  insist on it;
- limited to **Path=/dashboard**, so it isn't even sent to `/v1`.

Sessions end after `SESSION_IDLE_TIMEOUT_MS` unused (30 min) and
`SESSION_ABSOLUTE_TIMEOUT_MS` after login (12 h). Login always makes a new
session; logout, logout-all, and a password change (all other sessions) end
them.

We chose cookies over tokens kept by the frontend because a token in
JavaScript can be stolen by any script on the page; an HttpOnly cookie
can't. The price is CSRF, handled below.

**Sessions and API keys never mix:** session cookies only work on
`/dashboard/v1`, API keys only on `/v1`.

### CSRF and CORS

- **CORS** with credentials only for `DASHBOARD_ORIGIN` (exact match);
  other origins get no CORS headers and their preflights a 403.
- Every request that changes data (POST, PUT, DELETE, file uploads
  included) must carry `Origin: DASHBOARD_ORIGIN`, and, once signed in, a
  valid **CSRF token** in `X-CSRF-Token`.
- The token comes from `GET /dashboard/v1/auth/csrf`: an HMAC-SHA-256 of
  the session's token hash with `SESSION_SECRET`. It is tied to that one
  session, needs nothing stored, and is compared in constant time. Another
  site can't read it (CORS), so it can't forge a request with it.
- Sign-up and login have no session yet, so they rely on the Origin check
  (and JSON bodies, which force a preflight).
- Security headers on every dashboard answer: `Cache-Control: no-store`,
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`,
  `Referrer-Policy: no-referrer`, and HSTS when cookies are Secure.

### The dashboard API reuses the platform's logic

The routes live in `services/gateway/src/dashboard/` (models, services,
controllers, routes, schemas). They forward to the same internal routes
with the same shared code as `/v1` (storage and secrets forwarders, the
proxy connection checks, the API key service also used by `/admin`), so
streaming, limits, encryption and audit work exactly the same. A secret's
value is only returned by an owner-only **reveal** route, which the secrets
service records as `secret.revealed`; lists never contain values.

Its schemas generate a **separate** specification,
`api/openapi.dashboard.json`, for the frontend. CI checks it is up to date,
but it has no compatibility promise and no breaking-change check, and it is
kept out of the public specification and docs.

### Audit

New actor type `user` and actions `user.signed_up`, `user.logged_in`,
`user.login_failed`, `user.logged_out`, `user.password_changed`,
`membership.added` and `secret.revealed`, recorded in each of the user's
workspaces; a failed login for an unknown email goes to the platform chain.
Sign-up, password changes, API key changes and reveals are recorded
strictly (refused if they can't be); logins and logouts are best effort.

### The admin API

`/admin` is off unless `ADMIN_API_ENABLED=true`, which only the e2e tests
set, and the gateway refuses to start with it in production. Deployments
and the smoke tests use sign-up and the dashboard API instead.

## Consequences

- The frontend must send requests with credentials, get a CSRF token after
  signing in, and send it on every change.
- Rate limits and timing protection make sign-in slower to attack, not
  impossible; MFA is a later phase.
- Without email, account recovery needs an operator.

# 0038: Continue with Google or GitHub for dashboard accounts

- Status: Accepted
- Date: 2026-11-23
- Changes: dashboard sign up and log in (ADR 0016); lifts the "no SSO" limit
  for dashboard accounts only (user pools are unchanged)

## Context

Dashboard accounts were email and password only. The owner asked for
Continue with Google and Continue with GitHub on the sign in and sign up
pages, handled by the backend, and for an account to be reachable both ways
when it uses the same email.

## Decision

- **OAuth 2.0 authorization code flow, in the gateway only.** The buttons
  are plain links to `GET /dashboard/v1/auth/oauth/{provider}/start`. The
  gateway redirects to the provider with a random `state` and an S256 PKCE
  challenge. The state, provider and a 10 minute expiry are kept in a short
  HttpOnly cookie (`scp_oauth`, SameSite=Lax, path limited to the OAuth
  routes), signed with HMAC; the PKCE verifier is derived from the state
  with the session secret, so nothing secret is stored.
- **The callback** (`.../{provider}/callback`) checks the state against the
  cookie in constant time, exchanges the code with the client secret and
  verifier server to server, and reads the profile: Google's userinfo
  (`email_verified` must be true) or GitHub's primary verified email.
  Provider tokens are used once and never stored, logged or sent to the
  browser. It then starts the usual session (ADR 0024, 0037) and redirects
  to the dashboard; failures redirect to `/login?oauth_error=<reason>`.
- **Accounts.** A provider identity (provider and its user ID) is linked to
  one account. On a first sign in, an existing account with the same email
  is linked, and its password keeps working (the owner's choice). Otherwise
  a new account is created with no password and no workspace; the user
  creates one from Your workspaces. Accounts without a password have no
  password section in Account and confirm deleting the account by typing
  their email.
- Each provider is off until both its client ID and secret are set;
  `GET /auth/oauth/providers` tells the dashboard which buttons to show. The
  callback address is `GATEWAY_PUBLIC_ORIGIN` (the server's API address,
  https only in production).
- `user.oauth_linked` is recorded on the platform audit chain: it belongs to
  an account, not a workspace, and adding it to tenants'
  `/v1/audit-events` would change that public contract.

## Consequences

- People can sign in without a password.
- Email sign ups still aren't verified (the owner dropped verification).
  Someone who signs up first with another person's email keeps their
  password after that person links Google or GitHub; the account's
  sessions list shows every signed in session.
- The server needs HTTPS out to Google and GitHub. Client secrets live only
  in the local `.env` and the server's `/etc/secure-cloud-platform/secrets.env`
  (docs/google-github-sign-in.md).

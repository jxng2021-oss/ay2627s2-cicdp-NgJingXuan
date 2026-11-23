# 0037: Dashboard sessions renew for 30 days while in use

- Status: Accepted
- Date: 2026-11-23
- Changes: the session lifetimes of ADR 0024 (access and refresh tokens)

## Context

Dashboard sign-in uses two cookies, set and read only by the gateway:

- an **access token** (`scp_session`, SameSite=Lax) that proves the session
  for 15 minutes;
- a **refresh token** (`scp_refresh`, SameSite=Strict) that the gateway's
  session check uses, on its own, to issue new tokens when the access token
  has expired. There is no refresh route and the frontend never sees it.

On top of that, a session ended after **30 minutes without a request** and,
at the latest, **12 hours after logging in**, whatever the refresh token
said. Testing the live server showed the problem: the dashboard only talks
to the gateway when you click, so a tab left open for half an hour (while
testing the demo shop, for example) was logged out on the next click.

## Decision

- The access token still lives **15 minutes**.
- The refresh token lives **30 days** (`SESSION_REFRESH_TTL_MS`). Each silent
  renewal issues one new access token and one new refresh token, and the new
  refresh token gets a fresh 30 days. A session therefore ends only after
  **30 days without using the dashboard**. The 30-minute idle limit and the
  12-hour cap (`SESSION_IDLE_TIMEOUT_MS`, `SESSION_ABSOLUTE_TIMEOUT_MS`) are
  gone.
- Everything else stays: refresh only inside the gateway's session check; a
  refresh token works once, with a 30-second grace for parallel requests;
  a used refresh token seen again revokes the session; only SHA-256 hashes
  are stored; logging out, changing the password and signing out other
  sessions end sessions straight away.

## Consequences

- People stay signed in through breaks, as with most dashboards.
- A stolen refresh cookie is useful for longer. The cookies stay HttpOnly,
  Secure, SameSite and limited to `/dashboard`, refresh tokens still work
  once (so a thief and the real user cannot both keep using one), and the
  account settings list every session with a button to end the others.
- The session list's "expires" date now moves forward with use.

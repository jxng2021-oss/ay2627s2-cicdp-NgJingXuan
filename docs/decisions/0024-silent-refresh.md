# 0024: Silent session refresh on the server

- Status: Accepted (updates the session part of [0016](0016-dashboard-auth.md)); the idle and absolute limits replaced by a 30-day refresh token renewed on use ([0037](0037-dashboard-sessions-30-day-refresh.md))
- Date: 2026-11-16

## Context

A dashboard session was one cookie holding one token, valid for the whole
session (up to 12 hours, ending after 30 minutes unused). A stolen cookie
stayed useful for that long. The owner asked for short-lived tokens that
are renewed silently, by the backend: no refresh route, and nothing for
the frontend to do. When a request arrives without a valid access token,
the backend should renew it itself.

## Decision

- **Two tokens per session,** each 256 random bits, only their SHA-256
  stored (`sessions.token_hash` and `sessions.refresh_hash`):
  - the access token, in the session cookie (`scp_session`), works for
    `SESSION_ACCESS_TTL_MS` (15 minutes). The cookie's Max-Age matches, so
    the browser drops it when it expires;
  - the refresh token, in the refresh cookie (`scp_refresh`), lasts until
    the session's absolute end. It is `SameSite=Strict`; both cookies are
    HttpOnly, limited to `/dashboard` and Secure outside local development.
- **Silent refresh in the session check** (`currentSession`, run before
  every signed-in dashboard route): a valid access token is used as it is.
  If it is missing or expired and the refresh token is valid, both tokens
  are replaced in one database update, the new cookies are set on that
  same answer, and the request carries on. There is no refresh route and
  no change in the frontend; a 401 now means the session is really over.
- **Rotation with reuse detection.** A refresh token works once. The one
  just replaced is still accepted (without renewing again) for 30 seconds,
  because a browser often sends several requests at the same moment and
  only the first renews. Seen after that, it must have been copied: the
  whole session is revoked, its cookies cleared, and a warning logged
  (with the session and user IDs, never a token).
- **Refreshing never extends a session.** The idle timeout (30 minutes
  unused) and the absolute timeout (12 hours after login) apply to the
  refresh token too; after them, the user logs in again. Logout, "log out
  everywhere" and a password change end sessions as before, refresh tokens
  included.
- **CSRF tokens belong to the session** (an HMAC of its ID), not to a
  cookie's token, so they keep working when the tokens are replaced.

## Consequences

- Sessions from before this change have no refresh token: their users log
  in once more after the migration (`0004_session_refresh_tokens`).
- A stolen access token is useful for at most 15 minutes; a stolen refresh
  token is caught the first time both copies are used.
- The e2e stack uses 3-second access tokens (`tests/e2e/e2e.env`), so every
  dashboard API and browser test also exercises silent refresh.
- Only the dashboard has sessions; API keys on `/v1` are unchanged.

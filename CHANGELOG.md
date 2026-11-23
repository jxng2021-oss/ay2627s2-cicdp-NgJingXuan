# Changelog

All notable changes to the public API (`/v1`, described by
`api/openapi.v1.json`) are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/): within v1, a minor version only
adds things, and anything breaking would get a new version (`/v2/...`).

## [Unreleased]

### Added

- `passwordResetRequired` on the sign-in and refresh answers
  (`POST /v1/user-pools/{poolId}/sessions` and `.../sessions/refresh`) and on
  every pool user: `true` after a workspace owner reset the user's password.
  Send the user to choose a new one with
  `POST /v1/user-pools/{poolId}/users/{userId}/password`, which clears it.

### Changed

- New user pool events (`pool_user.*`, `pool_role.*`) are recorded in each
  pool's own log, shown in the dashboard under User management → User activity, and no
  longer appear in `GET /v1/audit-events`. Events recorded before stay there
  (docs/decisions/0036).

## [1.2.0] - 2026-11-21

User pools (your app's own users), their roles, and feature flags. Only
additions. Pools and flags are created and managed in the dashboard, which
arrives with the dashboard API; these routes use them with your API key.

### Added

- **User pools**, from your server with your API key:
  `POST /v1/user-pools/{poolId}/users` (sign up),
  `GET /v1/user-pools/{poolId}/users/{userId}`,
  `POST /v1/user-pools/{poolId}/users/{userId}/password`,
  `POST /v1/user-pools/{poolId}/sessions` (sign in: an ES256 JWT access
  token and a refresh token), `.../sessions/refresh` (each refresh token
  works once) and `.../sessions/revoke` (sign out).
- `GET /v1/user-pools/{poolId}/jwks.json`: a pool's public keys, **without
  an API key**, to verify access tokens with any JWT library.
- **Roles:** `GET` and `POST /v1/user-pools/{poolId}/roles`, and `GET`,
  `PATCH` and `DELETE /v1/user-pools/{poolId}/roles/{role}`: each role is a
  name with your app's own permissions (`orders:refund`; `orders:*` and `*`
  as wildcards), at most 50 per pool.
- `PUT` and `DELETE /v1/user-pools/{poolId}/users/{userId}/roles/{role}`:
  give a user a role or take it away (safe to repeat; at most 20 per user).
  `roles` on every user, and `roles` and `permissions` claims in access
  tokens.
- **Feature flags:** `POST /v1/flags/evaluate`: your flags' values for one
  user in one environment, with the reason for each.
- Audit events: the `user_pool.*`, `pool_user.*`, `pool_role.*` and
  `feature_flag.*` actions, and the `user_pool`, `pool_user`, `pool_role`
  and `feature_flag` resource types.

## [1.1.0] - 2026-11-21

Proxy connections with secret injection, connection policies and the
tenant audit log.

### Added

- Proxy connections: `PUT /v1/proxy-connections/{name}`,
  `GET /v1/proxy-connections` and `DELETE /v1/proxy-connections/{name}`. A
  connection holds an outside API's base URL and the **name** of the secret
  to add, never its value. The base URL is checked against the SSRF rules
  when it is saved.
- The proxy route `ANY /v1/proxy/{connection}/{path}`: forwards the request
  to the outside API with the secret's latest value added in the
  connection's header, and never returns it. Only https, hosts from the
  allowlist, and public addresses; redirects aren't followed.
- An optional `policy` on a connection: `allowedRoutes` (methods and paths),
  `rateLimit` (calls per window) and `amountLimit` (a whole number in a JSON
  body field, per call and per UTC day). It is checked before the secret is
  read, and a policy with limits fails closed (`503 SERVICE_UNAVAILABLE`)
  if its counters can't be reached.
- `GET /v1/proxy-connections/{name}/usage`: calls in the current window and
  today's amount total.
- Error codes for the proxy routes only: `PROXY_TARGET_BLOCKED` (403),
  `PROXY_SECRET_MISSING` (409), `UPSTREAM_REDIRECT` (502),
  `PROXY_POLICY_DENIED` (403) and `PROXY_RATE_LIMITED` (429, with
  `Retry-After`).
- `GET /v1/audit-events`: your tenant's own audit events, newest first,
  filtered by `from`, `to`, `action`, `outcome`, `resourceType` and
  `resourceId`, paginated with `limit` and `cursor`. Calls a policy refused
  are recorded as `proxy_connection.denied`, never with their body or
  amount.

## [1.0.0] - 2026-11-21

The first release of the API gateway in this repository.

### Added

- API key authentication: `Authorization: Bearer <key>` on every `/v1`
  route. Missing, wrong and revoked keys all get the same
  `401 UNAUTHORIZED`; a suspended tenant gets `403 FORBIDDEN`.
- Rate limits per API key (with a stricter limit for uploads) and for
  failed key attempts per IP, with `RateLimit-*` and `Retry-After` headers
  and `429 RATE_LIMITED`.
- One error format for every route:
  `{ "error": { "code", "message", "requestId" } }`, and an `X-Request-Id`
  header on every response.
- Files:
  - `POST /v1/storage/files`, streamed, limited by size while it arrives
    (`413 PAYLOAD_TOO_LARGE`) and by the tenant's quota
    (`413 STORAGE_QUOTA_EXCEEDED`); an optional `X-File-Name` header.
  - `GET /v1/storage/files`, the tenant's files (metadata only), newest
    first, with a cursor.
  - `GET /v1/storage/files/{id}`, always as an attachment with
    `X-Content-Type-Options: nosniff`.
  - `GET /v1/storage/files/{id}/metadata` and `DELETE /v1/storage/files/{id}`.
  - `GET /v1/storage/usage`: used, reserved and allowed bytes.
- Secrets:
  - `PUT /v1/secrets/{name}` (create, or add a new version),
    `POST /v1/secrets/{name}/rotate`, `GET /v1/secrets`,
    `GET /v1/secrets/{name}/versions` and `DELETE /v1/secrets/{name}`.
  - `GET /v1/secrets/{name}` returns metadata only. Secret values are
    write-only and never returned.
  - `503 SECRETS_SEALED`, with `Retry-After`, while the vault is sealed.
- `GET /health` and `GET /ready` (unversioned and never rate limited).

# Changelog

All notable changes to the public API (`/v1`, described by
`api/openapi.v1.json`) are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/): within v1, a minor version only
adds things, and anything breaking would get a new version (`/v2/...`).

## [Unreleased]

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

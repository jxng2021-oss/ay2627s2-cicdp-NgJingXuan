# secure-cloud API guide

Dev apps use secure-cloud through one versioned HTTP API, `/v1`. This guide
covers how to call it; the full contract is the OpenAPI spec
[`api/openapi.v1.json`](../api/openapi.v1.json), and the Node.js SDK
(`@secure-cloud/sdk`, documented at `/docs` on the dashboard) wraps every
route below.

| Where          | Address                                      |
| -------------- | -------------------------------------------- |
| Live API       | `https://api.securee-cloud.duckdns.org`      |
| Live dashboard | `https://securee-cloud.duckdns.org`          |
| Local API      | `http://127.0.0.1:8080` (`pnpm local:start`) |

## Authentication

Create an API key in the dashboard (**API keys → Create API key**). It is
shown once; store it in the dev app's server-side secrets, never in a browser
or a repository. Send it on every request:

```http
Authorization: Bearer <your API key>
```

- A missing, wrong or revoked key gets the same `401 UNAUTHORIZED`.
- A valid key for a suspended workspace gets `403 FORBIDDEN`.
- The workspace is always the one the key belongs to; there is no tenant
  header to set.
- Routes that need no key: `GET /health`, `GET /ready`, a user pool's public
  keys (`/v1/user-pools/{poolId}/jwks.json`), secure-cloud's webhook keys
  (`/v1/webhooks/keys`) and the address Stripe posts webhooks to
  (`/v1/webhooks/{endpointId}`, checked with Stripe's signature instead).

## Routes

| Area                                                 | Routes                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Secrets** (values are write-only)                  | `GET /v1/secrets`, `PUT /v1/secrets/{name}`, `GET /v1/secrets/{name}` (metadata only), `GET /v1/secrets/{name}/versions`, `POST /v1/secrets/{name}/rotate`, `DELETE /v1/secrets/{name}`                                                                                           |
| **Files** (encrypted at rest)                        | `POST /v1/storage/files`, `GET /v1/storage/files`, `GET /v1/storage/files/{id}`, `GET /v1/storage/files/{id}/metadata`, `DELETE /v1/storage/files/{id}`, `GET /v1/storage/usage`                                                                                                  |
| **Connections**                                      | `PUT /v1/proxy-connections/{name}`, `GET /v1/proxy-connections`, `GET /v1/proxy-connections/{name}/usage`, `DELETE /v1/proxy-connections/{name}`                                                                                                                                  |
| **Proxy** (call an outside API with a stored secret) | `GET`, `POST`, `PUT`, `PATCH`, `DELETE /v1/proxy/{connection}/{path}`                                                                                                                                                                                                             |
| **Webhooks**                                         | `POST /v1/webhooks/{endpointId}` (Stripe only), `GET /v1/webhooks/keys`, `GET /v1/webhook-events` (pull)                                                                                                                                                                          |
| **User pools**                                       | `POST /v1/user-pools/{poolId}/users`, `GET /v1/user-pools/{poolId}/users/{userId}`, `POST /v1/user-pools/{poolId}/users/{userId}/password`, `POST /v1/user-pools/{poolId}/sessions`, `POST …/sessions/refresh`, `POST …/sessions/revoke`, `GET /v1/user-pools/{poolId}/jwks.json` |
| **User pool roles**                                  | `GET`, `POST /v1/user-pools/{poolId}/roles`; `GET`, `PATCH`, `DELETE …/roles/{role}`; `PUT`, `DELETE /v1/user-pools/{poolId}/users/{userId}/roles/{role}`                                                                                                                         |
| **Feature flags**                                    | `POST /v1/flags/evaluate`                                                                                                                                                                                                                                                         |
| **Audit**                                            | `GET /v1/audit-events`                                                                                                                                                                                                                                                            |
| **Status**                                           | `GET /health`, `GET /ready`                                                                                                                                                                                                                                                       |

Owners create user pools, flags and webhook endpoints in the dashboard; the
API is what a dev app uses at run time.

### Calling an outside API through a connection

A connection stores an outside API's base URL, the **name** of a secret and
the header it goes in. The dev app calls the proxy route and secure-cloud adds
the secret on the way out, so the app never holds the key:

```http
POST /v1/proxy/stripe/checkout/sessions
Authorization: Bearer <your API key>
Content-Type: application/x-www-form-urlencoded

mode=payment&...
```

secure-cloud forwards this to `<base URL>/checkout/sessions` with the stored
key in the connection's header. It works with any HTTPS API that takes its
key in a header, as long as the host is on the platform's allowed list. A
connection's policy (allowed routes, calls per window, amount per call and per
day) is checked **before** the secret is read; the amount limit counts every
call the outside API accepted, paid or not.

## Responses and errors

Every error has the same shape and an `X-Request-Id` header with the same ID:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Secret not found",
    "requestId": "8a1f9c2e-…"
  }
}
```

| Status | Code                                           | Meaning                                                                                             |
| ------ | ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 400    | `BAD_REQUEST`                                  | Something sent isn't valid; the message says what                                                   |
| 401    | `UNAUTHORIZED`                                 | Missing, wrong or revoked API key (or, from a sign in, a wrong email or password)                   |
| 403    | `FORBIDDEN`                                    | The workspace is suspended                                                                          |
| 403    | `PROXY_POLICY_DENIED`                          | A connection's policy refused the call (route or amount)                                            |
| 404    | `NOT_FOUND`                                    | No such item in your workspace (another workspace's items look the same)                            |
| 409    | `CONFLICT`                                     | Already exists, like a taken email                                                                  |
| 413    | `PAYLOAD_TOO_LARGE` / `STORAGE_QUOTA_EXCEEDED` | The file is too big, or the workspace's storage limit is reached                                    |
| 429    | `RATE_LIMITED` / `PROXY_RATE_LIMITED`          | Too many requests; wait for the seconds in `Retry-After`                                            |
| 502    | `UPSTREAM_UNAVAILABLE`                         | The outside API couldn't be reached                                                                 |
| 503    | `SECRETS_SEALED`                               | The vault is sealed after a restart; secrets, files and connections are paused until it is unsealed |
| 503    | `SERVICE_UNAVAILABLE`                          | A part of the platform is down for a moment                                                         |

Quote the `requestId` when reporting a problem: it finds the request in the
logs and the audit log.

## Limits

- **Requests:** a rate limit per API key, per minute (`429` with `Retry-After`).
- **Uploads:** at most 1 GiB per file, counted while streaming.
- **Storage:** 1 GiB per workspace on the live server (`GET /v1/storage/usage`
  shows the use and the limit).
- **Lists** are paged: pass `limit`, and `cursor` from the previous page's
  `nextCursor`.

## Webhooks

Stripe sends its events to `/v1/webhooks/{endpointId}` (create the endpoint in
the dashboard). secure-cloud checks Stripe's signature, keeps a short event
(`payment.succeeded`, `payment.failed`, `refund.succeeded`) and either sends it
to the dev app's delivery address signed with ES256 in
`X-SecureCloud-Signature` (check it with the keys at `/v1/webhooks/keys`, or
`cloud.webhooks.verify()`), or keeps it for the dev app to pull from
`/v1/webhook-events`. Webhooks support Stripe only for now.

## Versioning

- The API is versioned in the path. Within `/v1`, changes only **add** things
  (routes, response fields, optional inputs).
- Every change is listed in [`CHANGELOG.md`](../CHANGELOG.md).
- CI compares the spec with `main` on every pull request (oasdiff) and fails
  on a breaking change. A breaking change goes to `/v2`, or, rarely, is listed
  with a reviewed reason in
  [`api/breaking-changes-allowed.txt`](../api/breaking-changes-allowed.txt).
- An interactive reference (Swagger UI) is served at `/docs` on the API only
  when `API_DOCS_ENABLED=true` (off on the live server).

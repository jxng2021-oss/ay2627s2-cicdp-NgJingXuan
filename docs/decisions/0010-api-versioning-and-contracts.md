# 0010: API versioning, OpenAPI and contract tests

- Status: Accepted
- Date: 2026-11-04

## Context

Customers' code calls the gateway. Until now the API was unversioned
(`/storage/*` forwarded almost anything to storage), had no written
description, and nothing stopped a change from silently breaking clients. The
gateway and storage also depended on each other's behaviour without that
being written down.

## Decisions

### Version in the path: `/v1/...`

- Public routes are `POST /v1/storage/files` and `GET /v1/storage/files/{id}`.
  The old `/storage/*` catch-all is gone: only these two routes reach storage.
- Path versioning is the easiest to see, log, route and test (in curl, in
  logs, in a future load balancer). A header-based version is easy to forget.
- `/health` and `/ready` stay unversioned: they are for infrastructure, not
  customers. `/admin` stays unversioned and out of the public specification;
  it's internal and temporary (until admin login).
- Breaking changes go into `/v2`, served next to `/v1`.

### One schema approach: TypeBox

Route parameters, headers, responses and errors are defined once with TypeBox
(`services/gateway/src/api/schemas.ts`). The same objects give:

- request validation (Fastify/ajv): a file ID must be a UUID v4, otherwise
  `400` in the normal error format, before any storage call;
- TypeScript types (`@fastify/type-provider-typebox`), so the handlers can't
  disagree with the schema;
- response serialization (undocumented fields are dropped);
- the OpenAPI document.

Uploads stay streamed: the body is declared as `application/octet-stream`
binary for the documentation only. The gateway's content-type parser leaves
it unread, so validation never loads a file into memory.

### OpenAPI generated from the code

`@fastify/swagger` builds the specification from the route schemas;
`pnpm api:generate` writes it to `api/openapi.v1.json`, which is committed.
Committing it makes every API change visible in pull request diffs, and gives
oasdiff a base to compare with. Routes without tags (admin) are hidden, and
there is no `servers` list, so no hostnames or internal services appear.
`/docs` (Swagger UI) is only served when `API_DOCS_ENABLED=true`.

### CI checks

- `api-spec`: the committed file must equal the generated one.
- `api-breaking-changes`: [oasdiff](https://github.com/oasdiff/oasdiff)
  `breaking --fail-on ERR` against the base branch (pull requests) or the
  previous commit (pushes to main). It runs in Docker, pinned by digest, like
  the security scanners. If the base has no specification it skips with a
  notice. Reviewed exceptions live in `api/breaking-changes-allowed.txt`, one
  line per change, each with a written reason.
- Both are required by `ci-success`.

We chose oasdiff because it understands OpenAPI semantics (a newly required
parameter, a removed response property) instead of comparing text, and it
separates errors from warnings and additions.

### Contract tests

- **Public:** a small validator (`api/validate.ts`, ajv) checks real
  responses against `api/openapi.v1.json`: every status must be documented and
  every JSON body must match its schema. Gateway unit tests cover 200, 201,
  400, 401, 403, 404, 413, 429, 500, 502, 503 and 504; e2e tests check the
  live stack.
- **Internal:** `api/internal/storage.openapi.json` is the gateway-to-storage
  contract, written by hand and kept separate from the public one. Storage's
  tests check its responses against it (provider), and the gateway's tests
  check the requests it sends (required `X-Tenant-Id` and `X-Request-Id`, no
  `Authorization`) against a fake storage that only gives replies the contract
  allows (consumer). A test also checks that storage's error codes are all
  documented publicly, because the gateway passes storage errors through.

We didn't adopt a contract-testing broker (e.g. Pact): both services live in
one repository and change in the same pull request, so a shared file checked
by both test suites gives the same protection with less machinery.

## Consequences

- Changing a route's schema requires regenerating and committing the
  specification, and a breaking change fails CI unless it moves to `/v2` or
  gets a reviewed exception.
- The specification and changelog are the customer-facing documentation.
- oasdiff needs Docker (as the scanners do); the check works locally with
  `pnpm api:breaking`.
- The old `/storage/*` routes were removed without a deprecation period. That
  was acceptable only because there are no external clients yet; from now on,
  removals need `/v2`.

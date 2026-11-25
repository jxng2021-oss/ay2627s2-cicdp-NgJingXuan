# 0009: Gateway protections: rate limits, request limits, request IDs, errors

- Status: Accepted
- Date: 2026-11-04

## Context

The gateway authenticates API keys (ADR 0008) but would still serve unlimited
requests, of unlimited size, at any pace. That allows one client to starve
others, brute-force keys or the admin token, fill the disk or hold
connections open forever. Failures were also hard to trace across the two
services, and errors had inconsistent shapes.

## Decisions

### Rate limits, counted in Redis

Fixed one-minute windows (configurable), counted in **Redis** so that every
gateway node shares the same counters once we run more than one. Each count is
a single Lua script (`INCR` plus expiry), which Redis runs atomically:
simultaneous requests, even on different nodes, can never both slip under the
limit.

| Limit                              | Keyed by  | Default      | Why                                   |
| ---------------------------------- | --------- | ------------ | ------------------------------------- |
| Requests                           | API key   | 600 / minute | One client can't starve the others    |
| Uploads (`POST /v1/storage/files`) | API key   | 60 / minute  | Uploads cost far more than reads      |
| Failed key attempts                | client IP | 20 / minute  | Stops key guessing                    |
| Admin requests                     | client IP | 30 / minute  | Stricter: the admin token is powerful |

- Responses carry `RateLimit-Limit`, `RateLimit-Remaining` and
  `RateLimit-Reset`; a `429 RATE_LIMITED` also has `Retry-After`.
- `GET /health` and `GET /ready` are never limited.
- **Limits must not reveal whether a key or tenant exists.** A blocked IP gets
  `429` _before_ its key is looked at, so a valid and an invalid key get the
  same answer. Every kind of failure (missing, wrong, revoked key) counts the
  same. A valid key never counts as a failure.
- The admin limit is checked before the admin token, so the token can't be
  guessed quickly.
- **Client IPs come from the connection, not from `X-Forwarded-For`**, unless
  `TRUST_PROXY` lists the exact proxies allowed to set it. Otherwise any client
  could send a fake header to get a fresh IP and escape the limits.
  `TRUST_PROXY=true` (trust anyone) is refused at startup.

### When Redis is down

Rate limits are a protection, not a feature clients depend on, while losing
the API would hurt every client. But some protections exist _only_ because of
the counters. So the behaviour differs by route:

| Request                                      | Without Redis                                                             | Why                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| API request with a valid key                 | **Served, without rate limits**; a warning is logged (at most every 30 s) | Availability matters more than per-key fairness for a short outage                            |
| API request with a missing/wrong/revoked key | **503**                                                                   | Failures can't be counted, and serving 401s without limits would allow unlimited key guessing |
| `/admin` routes                              | **503**                                                                   | The admin token is the most valuable target; never allow unlimited guesses                    |
| `GET /health`                                | 200                                                                       | Liveness: the process is up                                                                   |
| `GET /ready`                                 | 200 `"degraded"`                                                          | Ready to serve API traffic, but with protections reduced                                      |

`/ready` reports `postgres` and `redis` as `up` or `down` only, never hostnames
or error messages. It returns `503 "not_ready"` only when Postgres is down,
since nothing works without it. Redis connections fail fast (500 ms command
timeout, no queueing while disconnected) and reconnect in the background, so
an outage never makes requests hang.

### Request limits

- **Upload size:** `MAX_UPLOAD_BYTES` (1 GiB default). A larger
  `Content-Length` is refused at once. Without it, or if it lies, bytes are
  counted as they stream, and the upload is stopped as soon as it passes the
  limit. The client gets `413 PAYLOAD_TOO_LARGE`. The gateway reads and throws
  away the rest of the refused body, so the client isn't left blocked; after
  5 seconds the connection is cut. Storage enforces the same limit itself.
- **No partial files:** storage writes to a temporary `.part` file and deletes
  it if the upload is too large, cancelled or interrupted.
- **Headers:** at most 16 KB (`431` otherwise).
- **Slow clients:** headers must arrive within 10 s and a whole request within
  10 minutes; idle connections close after 60 s, keep-alive after 5 s. Storage
  calls time out (connect 5 s, response 30 s) with `504 UPSTREAM_TIMEOUT`.
- Files still stream end to end; nothing is held in memory.

### Request IDs

Every request gets a new UUID, returned as `X-Request-Id`. Client-supplied
IDs are ignored, so they can't forge or confuse log entries. The gateway sends
its ID to storage, which uses it too (only if it's a valid UUID), so one ID
finds a request in both services' logs. Logs never contain API keys,
`Authorization` headers, admin tokens or file contents.

### One error format

```json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "Too many requests, try again later",
    "requestId": "…"
  }
}
```

Codes are stable (`BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`,
`PAYLOAD_TOO_LARGE`, `RATE_LIMITED`, `INTERNAL_ERROR`, `UPSTREAM_UNAVAILABLE`,
`UPSTREAM_TIMEOUT`, `SERVICE_UNAVAILABLE`). Unexpected errors return only
`INTERNAL_ERROR`; the details (stack traces, database errors, hostnames) go to
the logs under the same request ID. Two responses are produced by Node itself
before our code runs and keep its plain format: `431` (headers too large) and
`408` (headers too slow).

### Graceful shutdown

On `SIGTERM`, each service answers new requests with `503`, lets requests in
progress finish, then closes its database, Redis and upstream connections. If
that takes longer than `SHUTDOWN_TIMEOUT_MS` (25 s), it exits anyway. Compose
waits 30 s before killing a container.

## Consequences

- Rate limits need Redis; without it API traffic is unlimited until it
  returns, which the warning makes visible.
- Clients behind one shared IP (an office NAT) share the failed-attempt and
  admin limits; a misbehaving client there can block the others for a minute.
- Fixed windows allow a short burst of up to twice the limit across a window
  boundary. That is acceptable for abuse protection; a sliding window could
  replace it later.
- When a load balancer arrives, `TRUST_PROXY` must list its addresses or every
  client will appear to share its IP.

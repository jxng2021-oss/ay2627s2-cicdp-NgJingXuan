# 0019: Policies on proxy connections

- Status: Accepted; the amount limit also reads form bodies such as Stripe's ([0039](0039-demo-shop-pays-with-stripe.md))
- Date: 2026-11-12

## Context

The platform's focus is "apps never hold their own keys, and can't misuse
the ones they borrow". Secret injection (ADR 0013) covers the first half: an
app calls an outside API through a connection and never sees the key. But an
app that is broken into can still use the connection as much as it likes:
any path, any number of times, any amount. ADR 0013 deliberately left out
per-connection limits; this decision adds them.

## Decisions

### An optional policy on each connection

Stored as JSON on the connection (gateway database, migration 0003). Every
part is optional; a connection without a policy behaves exactly as before.

| Part            | What it limits                                                                              |
| --------------- | ------------------------------------------------------------------------------------------- |
| `allowedRoutes` | Methods and paths below the base URL (`*` = one path segment, HEAD = GET), at most 20       |
| `rateLimit`     | Calls per window, for the whole workspace                                                   |
| `amountLimit`   | A whole, positive number at a top-level JSON body field: a maximum per call and per UTC day |

The same checks are used by the public API and the dashboard API (one
`checkConnection`, one schema), and the dashboard shows the policy and its
usage.

### Checked before the secret is read

The order on the proxy route is: find the connection, check the target
(SSRF rules), **check the policy**, then read the secret and forward. A
refused call never fetches or injects the key, so a policy can't be used to
learn anything about it, and a flood of refused calls doesn't touch the
secrets service.

### Counters in Redis, atomic, failing closed

- The call count uses the existing fixed-window counter (atomic Lua).
- The day's amount is **reserved** with one atomic script: add the amount
  only if the new total stays within `maxPerDay`. Two simultaneous calls
  can't both squeeze under the limit. The key expires at the end of the UTC
  day.
- The amount is **given back** if the call doesn't happen or fails: the
  secret can't be read (sealed, missing), the outside API can't be reached,
  redirects, or answers with an error status (3xx and above). A declined
  card shouldn't use up the day's budget.
- **Fail closed.** Normal API requests are served without rate limits when
  Redis is down (ADR 0009), but a policy is a guardrail on someone else's
  money or quota: a connection with a rate or amount limit answers `503
SERVICE_UNAVAILABLE` until its counters are back. A connection with only
  allowed routes needs no counters and keeps working.

### Reading the amount

Only for POST, PUT and PATCH on a connection with an amount limit, and only
as much as needed: the body must be `application/json` and at most 16 KiB
(413 otherwise), and the amount must be a safe whole number from 1 up at the
named top-level field. That small body is read into memory for the check,
then forwarded exactly as received; every other body is still streamed
(CLAUDE.md: never buffer a whole file). Refusals use a fixed message per
reason and never echo the body or the amount.

### Errors and the API contract

- `403 PROXY_POLICY_DENIED` (route not allowed, amount missing, amount too
  high, daily limit reached) and `429 PROXY_RATE_LIMITED` with
  `Retry-After`.
- Within v1, as additions: the optional `policy` input, `policy` in
  responses (`null` without one), `GET /v1/proxy-connections/{name}/usage`.
  Each new code was added to exactly one existing status of the proxy route
  (403 and 429); oasdiff counts a new enum value as breaking, so those 12
  lines (6 methods x 2) are listed with a reason in
  `api/breaking-changes-allowed.txt`, as was done for encrypted storage
  (ADR 0014). Only connections whose owner adds a policy can ever return
  them. API version 1.6.0.

### Audit

Every refused call is recorded as `proxy_connection.denied` (outcome
`denied`, tenant chain, best effort like other proxy events) with its
request ID. The audit log has no free-text field, and adding one would
change the fields covered by the chain's HMAC (a new chain format version).
So the **reason** is in the API answer and in the gateway's log line for
that request ID, not in the audit entry.

## Consequences

- An app with a policy can't call other endpoints of the outside API, can't
  call faster than allowed, and can't spend more than the daily amount, even
  if it is fully compromised.
- Policies only understand one amount field in a JSON body: APIs that send
  amounts as form data, in the path or in nested objects need a different
  rule (not built).
- Changing a policy's window doesn't reset an ongoing window; changing the
  daily maximum takes effect on the next call.
- The demo shop's `payments` connection gets a policy (only `POST
/charges`, S$500 a charge, S$2,000 a day, 20 calls a minute), so a
  too-large order is refused by the platform before the payment key is used.
- Out of scope: approvals above a limit, per-key scopes, limits per API key.

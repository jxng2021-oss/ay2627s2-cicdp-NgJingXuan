# 0008: Tenants and API key authentication

- Status: Accepted
- Date: 2026-11-04

## Context

The storage API was open to anyone who could reach the gateway. Apps need to
authenticate, and each customer (tenant) must only ever see its own files.
Keys must stay safe even if the database leaks, and attackers must learn as
little as possible from failed attempts.

## Decisions

**Postgres with Drizzle and versioned migrations.** Tenants and keys are
relational data with constraints (unique key prefixes, foreign keys). Drizzle
gives typed queries in TypeScript and generates plain SQL migration files that
are reviewed and committed. A one-off `migrate` service applies pending
migrations before the gateway starts, and running it again is a no-op.
Postgres is only on the internal Docker network.

**Key format: `sk_<env>_<lookup ID>_<secret>`.**

- `sk_local_` / `sk_staging_` / `sk_production_` makes keys easy to recognise,
  for people and for secret scanners, and shows which environment a key belongs
  to.
- The **lookup ID** (8 random bytes) finds the key's row with one indexed
  query, without the secret. It's not sensitive, so it's shown in key lists to
  tell keys apart.
- The **secret** is 32 bytes (256 bits) from `crypto.randomBytes`, the
  operating system's cryptographically secure generator. That is far beyond
  guessing range.

**Only a keyed hash is stored: HMAC-SHA-256 of the whole key, with a
server-side secret (`API_KEY_HASH_SECRET`).**

- The key itself is never stored or logged. It is returned once, when it's
  created.
- A plain SHA-256 would already make the database useless for logging in,
  because 256-bit random keys can't be brute-forced. The HMAC adds a second
  layer: without the server-side secret, which lives in the environment and
  not in the database, a stolen database can't even be used to test candidate
  keys.
- A slow password hash (bcrypt, Argon2) isn't needed: those protect
  low-entropy human passwords, and would make every API request slower.

**Checking a key, in constant time.** The gateway parses the key, looks up the
row by its lookup ID, computes the HMAC of the presented key, and compares it
with the stored hash using `crypto.timingSafeEqual`, so response times don't
reveal how much of a guess was right. The temporary admin token is compared
the same way, after hashing both sides so their lengths always match.

**Same 401 for every failure.** Missing, malformed, unknown, wrong and revoked
keys all get an identical `401` body, so an attacker can't tell a revoked key
from a typo. A suspended tenant gets `403`, but only for an otherwise valid
key. Telling a key's owner that the account is suspended is useful, and it
reveals nothing to anyone else.

**The tenant comes only from the verified key.** The gateway removes any
client-supplied `X-Tenant-Id` (and the `Authorization` header) and sets
`X-Tenant-Id` itself before calling storage. Storage requires that header,
accepts traffic only from internal (private) addresses, validates both the
tenant ID and the file ID as UUIDs before building a path, and keeps each
tenant's files in its own folder. Asking for another tenant's file returns
`404`, exactly as if it didn't exist.

**Temporary admin API.** Tenants and keys are managed through `/admin`,
protected by one shared `ADMIN_TOKEN` from the environment. That is a
stopgap: proper admin accounts and login come with the admin dashboard.

## Consequences

- Rotating `API_KEY_HASH_SECRET` invalidates every existing key. A planned
  rotation would need to check against old and new secrets for a while.
- Revocation takes effect on the next request; there is no key cache.
- `last_used_at` is updated at most once a minute per key, to limit writes.
- There is no rate limiting yet. Brute force is hopeless against 256-bit
  keys, but repeated requests still cost database lookups; rate limits come in
  a later phase.
- Files stored before this change (not inside a tenant folder) are no longer
  reachable through the API. Locally, `pnpm local:reset` clears them.

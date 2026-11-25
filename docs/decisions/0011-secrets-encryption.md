# 0011: Secrets service and encryption

- Status: Accepted (the master key's source superseded by ADR 0012); implemented in Rust by [0034](0034-rust-secrets-service-and-shamir-port.md), with the same design and storage format
- Date: 2026-11-04

## Context

Tenants need to store secrets (database passwords, API tokens, keys) and read
them back through the API. A secret must stay confidential even if someone
gets a copy of the database (a backup, a stolen disk, a SQL injection, a
curious operator), and one tenant must never be able to read another's.
Later phases add sealed startup, secret injection and file encryption; this
first version must make those possible without rewriting stored data.

## Decisions

### A separate service with its own database

`services/secrets` is a new internal service, like storage: only reachable on
the internal Docker network, never published on the host, called only by the
gateway, which checks the API key and passes the tenant in `X-Tenant-Id`.

It has its **own Postgres database (`secrets`) and login (`secrets_app`)**,
with its own Drizzle migrations. The gateway now uses its own login
(`gateway_app`) too. Neither is a superuser, and `CONNECT` is revoked from
everyone else, so the gateway's login can't open the secrets database and the
secrets login can't open the gateway's (tested in
`tests/e2e/database-separation.test.ts`). A bug or injection in one service
can't read the other's data. The logins are created by
`deploy/postgres-setup.sql`, run by a one-off `db-setup` service on every
start (safe to re-run). One Postgres server is kept for now: a second server
would add cost and operations for little extra isolation at this stage.

### The key hierarchy (envelope encryption)

```
master key (KeyProvider)
  └─ encrypts ─▶ tenant key  (one random 256-bit key per tenant, stored encrypted)
                   └─ encrypts ─▶ secret values (every version)
```

- **Secret values** are encrypted with their tenant's key.
- **Tenant keys** are random (`crypto.randomBytes(32)`), created the first
  time a tenant saves a secret, and stored only encrypted by the master key.
- **The master key** never touches the database.

Why not encrypt everything with the master key directly? Separate keys
limit what a mistake affects, and make the next steps cheap:

- **Rotating the master key** only re-encrypts the small tenant keys, not
  every secret.
- **A tenant's data can be destroyed** by deleting its key
  ("crypto-shredding").
- A bug that mixes up two tenants' data fails to decrypt rather than leaking.

### The algorithm

**AES-256-GCM** from Node's built-in `crypto` module (OpenSSL). Nothing is
home-made: we only call the standard algorithm, with:

- a **new random 96-bit nonce for every encryption** (`randomBytes(12)`);
  reusing a nonce with the same key would break GCM;
- the full **128-bit authentication tag**, checked on every decryption, so
  any change to the ciphertext, nonce or tag is detected;
- nonce, ciphertext and tag stored in separate `bytea` columns.

### Authenticated data binds every value to its place

GCM's additional authenticated data (AAD) isn't encrypted, but decryption
fails unless it matches exactly. We use it to bind each encrypted item to
where it belongs:

| Item         | AAD (a JSON array, so fields can't run together)                              |
| ------------ | ----------------------------------------------------------------------------- |
| Tenant key   | `["tenant-key", formatVersion, masterKeyVersion, tenantId, tenantKeyVersion]` |
| Secret value | `["secret-value", formatVersion, tenantKeyVersion, tenantId, name, version]`  |

Someone with write access to the database could copy tenant A's encrypted
value into tenant B's row, or version 1 over version 2, or one name over
another. Without AAD that copy would decrypt fine and return the wrong data.
With it, decryption fails. The format and key versions are in the AAD too, so
the stored headers can't be changed either. Tests cover each of these cases.

### Versions in every encrypted item

Every row stores a **format version** (today `1`) and the **version of the
key** that encrypted it (master key version for tenant keys, tenant key
version for values). That lets us later:

- rotate the master key (wrap tenant keys under version 2, read both),
- rotate tenant keys,
- change the format,

all without guessing how old data was written. A committed, test-only
fixture (`services/secrets/test/fixtures/compatibility-v1.json`, encrypted
once with a fake master key) is decrypted in CI (`secrets-compatibility`
job), so no release can silently make existing secrets unreadable.

### The master key behind an interface (KeyProvider)

The code only sees a small interface (`src/crypto/key-provider.ts`): the
current master key version, the master key for a version, and whether it is
available. The first version read the master key from an environment
variable as a temporary measure. **That was replaced by sealed startup**
([ADR 0012](0012-sealed-startup.md)): the master key is now random, stored
only encrypted by an unseal key that is split into shares, and only ever in
memory while unsealed. The rest of this ADR is unchanged by that.

### Concurrency

- **First request of a new tenant:** two requests may both create a tenant
  key. Each tries to insert version 1. A unique key on
  (tenant, key version), plus a partial unique index allowing only one
  `active` key per tenant, keep exactly one. The loser's insert does nothing
  (`ON CONFLICT DO NOTHING`), and it reads the winner's key.
- **Simultaneous writes to one secret:** the next version number is reserved
  with one atomic `INSERT ... ON CONFLICT DO UPDATE SET latest_version =
latest_version + 1 ... RETURNING`. Postgres locks the row until the
  transaction commits, so two writers always get different numbers. The
  (secret, version) primary key is a second guard.

### API rules

- The tenant comes only from the gateway's verified key (`X-Tenant-Id`). The
  gateway forwards only validated values (name, version, limit, cursor,
  `{"value"}`), never client headers.
- Another tenant's secret is the same `404` as a missing one, on every route.
- Names are strict: 1-128 of `[A-Za-z0-9_.-]`, starting with a letter or digit.
- Values are limited to `MAX_SECRET_BYTES` (64 KiB of UTF-8 by default),
  checked by both the gateway and the service.
- JSON bodies are validated strictly (no type coercion, no ignored fields).
- Every secrets response has `Cache-Control: no-store`.
- Lists never contain values, and are paginated with a cursor.
- Values, keys, request bodies and decrypted data are never logged (tested).
- A decryption failure is logged with a safe reason (no data) and returned
  as the same generic `500` as any internal error, so clients can't learn why.
- Error messages for invalid JSON are fixed text, because the parser's own
  message can quote part of the body.

## Consequences

- The master key's protection is described in ADR 0012 (sealed startup).
- The gateway's migrations still run as the admin login (which owns its
  tables); the running gateway uses `gateway_app`, which can read and write
  but not change the schema.
- Reading a secret costs two small decryptions (tenant key, then value);
  tenant keys aren't cached yet.
- Rotating the master key, rotating tenant keys and crypto-shredding are
  possible with the stored versions, but not built yet.
- Rolling back to a release from before the secrets service stops it, but
  leaves its database untouched (rollback restores code, not data).

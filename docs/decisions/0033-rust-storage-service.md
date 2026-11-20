# 0033: The storage service in Rust, and its libraries

- Status: Accepted
- Date: 2026-11-21

## Context

The platform was first built entirely in TypeScript on Node.js (ADR 0001).
Two services handle the most sensitive work: **storage** encrypts and
decrypts every file while streaming it, and **secrets** holds the master key
and every tenant key. ADR 0014 already notes a weakness of doing this in
JavaScript: key buffers are overwritten with zeros after use, "as far as
JavaScript allows", because Node's crypto and the garbage collector may keep
copies we can't reach.

When the project was rebuilt in the course repository, we decided to move
these two services to a language that gives more control over memory, and
to keep everything else in TypeScript. Storage is done first; secrets
follows later (KAN-126).

The rewrite must not change anything outside the service: the gateway keeps
calling the same internal API (`api/internal/storage.openapi.json`), and
files encrypted by the TypeScript version must still decrypt (format
version 1, `tests/storage/fixtures/compatibility-v1.*`).

## Decision

### Language: Rust for storage (and later secrets), TypeScript for the rest

| Option          | For                                                                                                                                                            | Against                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Keep TypeScript | One language, already working, fast to change                                                                                                                  | Can't reliably erase keys from memory; garbage-collected memory use while streaming large files            |
| Go              | Simple, fast to compile, good standard library for HTTP                                                                                                        | Also garbage collected: no reliable way to erase key copies; no `zeroize` equivalent the compiler respects |
| **Rust**        | Memory safety without a garbage collector; key types that erase themselves when dropped (`zeroize`); predictable memory while streaming; a small static binary | A second toolchain, slower builds, a steeper learning curve, two languages in CI                           |

Rust was chosen because it removes the exact weakness ADR 0014 records,
while keeping memory safety. The cost is accepted only where it buys
security: the gateway, audit, identity, flags, dashboard and SDK stay in
TypeScript, where shared schemas and fast iteration matter more.

### Libraries

| Need                       | Chosen                              | Considered             | Why                                                                                                                                                                                                                                                                                |
| -------------------------- | ----------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Async runtime              | tokio                               | async-std              | The standard runtime; axum, sqlx and reqwest are built on it; async-std is no longer developed                                                                                                                                                                                     |
| HTTP server                | axum                                | actix-web, Rocket      | Built by the tokio team on `tower` middleware; streams request and response bodies without buffering; plain functions as handlers                                                                                                                                                  |
| Database                   | sqlx (Postgres)                     | Diesel, tokio-postgres | Async; plain SQL like the Drizzle migrations; migrations built into the binary (`storage migrate`); `#[sqlx::test]` gives every test its own fresh database. Diesel's core is synchronous and has its own query language; tokio-postgres has no migrations                         |
| Encryption                 | RustCrypto `aes-gcm` with `zeroize` | ring, openssl          | Pure Rust, publicly audited (NCC Group, 2020), erases its key schedule when dropped. openssl needs a C library, which complicates the static Alpine build; ring is also sound, but `aes-gcm` works directly with `zeroize` and matches the other RustCrypto crates we use (`sha2`) |
| Erasing secrets            | `zeroize`                           | manual overwriting     | Writes that the compiler is not allowed to optimise away; `Zeroizing<...>` wrappers erase keys and plain data when they go out of scope                                                                                                                                            |
| Checksums                  | `sha2`                              | ring                   | Same RustCrypto family as `aes-gcm`                                                                                                                                                                                                                                                |
| JSON                       | serde, serde_json                   | none                   | The standard for Rust                                                                                                                                                                                                                                                              |
| Logs                       | tracing, tracing-subscriber (JSON)  | log, env_logger        | Structured JSON lines with the same fields as the TypeScript services                                                                                                                                                                                                              |
| Calls to secrets and audit | reqwest, without TLS features       | hyper directly         | Simple client; TLS is left out because these calls stay on the internal Docker network, which keeps OpenSSL and rustls out of the image                                                                                                                                            |

### Pinning and safety settings

- **Toolchain:** Rust 1.95.0 in `rust-toolchain.toml`, with rustfmt and
  clippy. The Docker build uses `rust:1.95-alpine3.22`.
- **Crates:** every dependency is pinned to an exact version (`=x.y.z`) in
  `services/storage/Cargo.toml`, and `Cargo.lock` is committed. Every build
  and test uses `--locked`, so it fails instead of picking new versions.
- **Lints:** `unsafe_code = "forbid"` (no unsafe Rust anywhere in the
  service) and `clippy::unwrap_used = "deny"` (no unhandled panics from
  `unwrap`). CI runs clippy with warnings as errors, and `cargo fmt --check`.
- **Image:** multi-stage build, compiled in `rust:1.95-alpine3.22`, run from
  `alpine:3.22` as a non-root user. The image is 24 MB, against about
  345 MB for a Node service image.

### Keeping the contract

- The same routes, JSON shapes, headers and error codes, checked by
  `tests/storage/contract.rs` against `api/internal/storage.openapi.json`.
- The same chunk format (64 KiB AES-256-GCM chunks, nonce and AAD as in
  ADR 0014), checked by decrypting the TypeScript fixture in
  `tests/storage/compatibility.rs`. The fixture is never edited or
  regenerated.
- The same database schema, now applied by sqlx instead of Drizzle.

## Consequences

- Keys and decrypted data are erased when they go out of scope, which
  TypeScript could not promise.
- Memory use while streaming stays flat: at most one 64 KiB chunk per
  transfer in plain form.
- The storage image is about 14 times smaller than a Node service image.
- CI now needs a Rust toolchain and caches Cargo builds; a first build
  takes several minutes.
- Contributors need to know two languages. The internal contracts and the
  compatibility fixture are what keep the two sides in step.
- Trivy can't see the Rust crates inside the stripped binary, so Rust
  dependencies need their own scanner (cargo audit or cargo deny, KAN-111).
- Not yet done: secrets in Rust (KAN-126), with a reviewed Shamir crate
  (KAN-27).

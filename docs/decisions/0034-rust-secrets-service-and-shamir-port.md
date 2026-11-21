# 0034: The secrets service in Rust, and a port of the audited Shamir library

- Status: Accepted
- Date: 2026-11-22

## Context

ADR 0033 moved storage to Rust and said secrets would follow (KAN-126). The
secrets service holds the master key and every tenant key, so it gains the
most from Rust: keys live in `Zeroizing` buffers that are erased when they
are dropped, with no garbage collector keeping copies.

The rewrite must not change anything outside the service:

- the internal API stays `api/internal/secrets.openapi.json`;
- everything encrypted by the TypeScript version must still decrypt: secret
  values and tenant keys (`tests/secrets/fixtures/compatibility-v1.json`),
  and the file keys and signing keys other services hold
  (`tests/secrets/fixtures/wrapped-keys-v1.json`, made by the TypeScript
  code before the rewrite);
- the tables stay the same, so the e2e tests' database checks still apply.

Sealed startup needs Shamir's Secret Sharing (ADR 0012: 3 of 5 shares). The
project rule was: use `shamir-secret-sharing` (audited, pinned), never our
own implementation.

## The Shamir problem

We looked for an audited Rust crate on 22 Nov 2026 and found none:

| Crate                                | Status                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| vsss-rs                              | The most widely used. Its 4.x docs said "currently under audit"; no results were published. |
| sharks                               | RUSTSEC-2024-0398 (biased coefficients), no fixed release.                                  |
| blahaj                               | The fork that fixes sharks. Not audited.                                                    |
| horcrux                              | Says it is a prototype, not audited and not constant time.                                  |
| shamir_share, shamir-vault, shamirss | Self-described properties only; shamirss advises against cryptographic use.                 |

The TypeScript library the service already used, `shamir-secret-sharing`
0.0.4 by Privy, has been audited by Cure53 and Zellic.

## Decision

**Port `shamir-secret-sharing` 0.0.4 to Rust line for line**
(`services/secrets/src/seal/shamir.rs`), and check the port against the
audited library in both directions.

- The GF(2^8) log and exp tables (polynomial x⁸ + x⁴ + x³ + x + 1, generator
  0xe5, from HashiCorp Vault) were extracted from the library's source by a
  script, not retyped.
- `split`, `combine`, the Lagrange interpolation, Horner evaluation, the
  coordinate shuffle and every argument check (with the same messages) follow
  the TypeScript code. The share format is the same: the y bytes, then the x
  coordinate as the last byte.
- Coefficients are uniformly random bytes, zero included, exactly as 0.0.4
  does. Cure53's finding PVY-01-002 led Privy to force a non-zero leading
  coefficient in 2023; Privy reverted that on 10 Jan 2025 (#22) before
  releasing 0.0.4, and we follow the released, audited version.
- Every buffer that holds a secret, a coefficient or a share is `Zeroizing`.

**Verification:**

- `tests/secrets/fixtures/shamir-v1.json` holds shares made by the audited
  library (2 to 255 shares, thresholds 2 to 7 and all-of-6). The Rust
  `combine` rebuilds every secret from every threshold-sized group tested.
- Shares made by the Rust `split` were combined by the audited library: 240
  groups, all correct (a one-off check while writing this ADR; the fixture
  test keeps the combine direction checked in CI).
- Round trips, fewer-than-threshold groups, share layout and argument errors
  are tested in `tests/secrets/shamir.rs`.

**Integrity**, which the library leaves to the caller: the combined unseal
key decrypts the master key with AES-256-GCM, so a wrong or damaged share
fails authentication instead of producing a wrong key, and every 3-of-5
combination is checked at initialisation before anything is saved.

## Consequences

- The rule changes from "never our own" to: Shamir only through this port of
  the audited library; change it only together with the fixture test and the
  TypeScript cross-check.
- **The port itself has not been audited.** It is a small, mechanical
  translation verified against the audited code, but it is new code. An
  independent review of `shamir.rs` is the first thing to do before real
  secrets depend on it.
- Like the original, it uses lookup tables, so it is not guaranteed constant
  time. Shares only exist inside the secrets container while an operator
  unseals it, which limits who could measure timings.
- Shares made by the TypeScript service can be used with the Rust one, so an
  existing vault does not need to be initialised again.

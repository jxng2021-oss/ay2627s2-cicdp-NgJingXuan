# 0012: Sealed startup for the secrets service

- Status: Accepted; implemented in Rust by [0034](0034-rust-secrets-service-and-shamir-port.md), with a verified port of the audited Shamir library
- Date: 2026-11-04

## Context

The secrets service (ADR 0011) encrypts every tenant key with a master key.
Its first version read that master key from an environment variable, so it
sat in plain form in the server's secrets file and in the container's
environment: anyone who could read either could decrypt every secret, and
one lost file meant every secret was gone. We want the master key never to
be stored in plain form anywhere, and no single person or file to be able to
unlock the secrets alone. AWS isn't available yet (local-first), so this
must not depend on a cloud key service.

## Decisions

### Key design

```
unseal key  (random 256-bit; split into 5 shares, any 3 rebuild it; never stored)
  └─ encrypts ─▶ master key  (random 256-bit; stored only encrypted; in memory only while unsealed)
                   └─ encrypts ─▶ tenant keys ─▶ secret values   (unchanged, ADR 0011)
```

- **Stored in Postgres** (`seal_config`, one row at most): the master key
  encrypted with AES-256-GCM under the unseal key, plus the seal settings
  (5 shares, threshold 3), a random seal ID, and format and key versions.
  The authenticated data binds the encrypted master key to all of these, so
  none can be changed unnoticed.
- **Shamir's Secret Sharing** splits the unseal key into 5 shares, of which
  any 3 rebuild it and 2 reveal nothing. We use the `shamir-secret-sharing`
  npm package (Privy, version 0.0.4, pinned exactly): zero dependencies,
  independently audited by Cure53 and Zellic. We don't implement Shamir
  ourselves. Shares are base64 text for operators to copy.
- **Encryption** stays Node's built-in AES-256-GCM, with a new random nonce
  each time.

### Initialisation (once)

`node dist/operator.js init`, inside the container:

1. Makes a random master key, a random unseal key and a random seal ID.
2. Encrypts the master key, and splits the unseal key into 5 shares.
3. Before saving anything, checks that **every** group of 3 shares (all 10) rebuilds the unseal key and decrypts the master key.
4. Saves the settings and the encrypted master key in **one atomic insert**
   into a table that can hold one row only. Two simultaneous attempts: one
   wins, the other is refused. Any failure before that leaves nothing
   behind, so `init` can simply be run again. It refuses while keys from an
   earlier setup are still stored, since new keys couldn't decrypt them.
5. Shows the 5 shares **once**. They are never stored or logged, and the
   keys and shares are overwritten in memory.
6. Leaves the service sealed: unsealing straight away proves the shares were
   copied correctly.

### Sealed startup and unsealing

- The service **always starts sealed**, after any restart or crash: there is
  no master key in memory and none on disk.
- While sealed, every secrets route answers **`503 SECRETS_SEALED`** with
  `Retry-After`. `/health` stays `200`, so Docker doesn't restart the
  container in a loop. `/ready` is `503` with a reason (`sealed`,
  `not_initialised` or `postgres_down`). The gateway and storage don't
  depend on it.
- `node dist/operator.js unseal` takes **one share at a time**, from a
  hidden prompt (or stdin for scripts), **never as a command-line argument**.
  Shares are kept in memory only. Duplicates are ignored, and progress
  ("2 of 3 shares") never shows share contents.
- With 3 shares, the unseal key is rebuilt and decrypts the master key. If
  that fails (wrong share, another initialisation, changed data), progress
  is cleared and the answer is the same generic failure, so it doesn't
  reveal which share was wrong.
- Partial progress is forgotten after `UNSEAL_TIMEOUT_MS`. After
  `UNSEAL_MAX_FAILED_ATTEMPTS` failures, shares are refused for
  `UNSEAL_LOCKOUT_MS`.

### Sealing

`node dist/operator.js seal`:

1. New secrets requests are refused at once.
2. Running requests get `SEAL_DRAIN_TIMEOUT_MS` to finish.
3. The master key Buffer is overwritten with zeros.

Shutting down also seals. **JavaScript can't guarantee memory is fully
erased:** the engine, the garbage collector and OpenSSL's copy inside a
`KeyObject` may keep bytes we can't reach, and shares typed as text live in
immutable strings until collected. Overwriting is best effort, and we
document it as such.

### Operator actions are not on the API

Operator commands use a **separate listener on a Unix socket**
(`/run/secrets-operator/operator.sock`). It lives on a private tmpfs inside
the secrets container, is owned by its non-root user, and is mode 0600.

- It isn't on any network port and isn't routed by the gateway.
- Other containers and the host can't reach it.
- The service's HTTP API has no init, unseal or seal routes (tested in unit
  and e2e tests, including from inside the gateway's container).
- The operator listener has no logger, so shares can't be logged.

### A hardened container

The secrets container has a read-only root filesystem (only `/tmp` and the
socket folder are writable tmpfs). It drops all Linux capabilities, sets
`no-new-privileges`, runs as the `node` user, and **disables core dumps**
(`ulimit core 0`), so a crash never writes keys to disk. `pnpm test:stack`
checks all of these on the running container.

### The test key provider stays in tests

A fixed-key `KeyProvider` (`test/test-key-provider.ts`) exists only under
`test/`, which production builds don't compile. The compatibility fixture
(ADR 0011) still decrypts through it. Nothing in `src/` reads a master key
from the environment, and a test checks that the old setting has no effect.

### Local development, CI and deployments

- **Locally**, `pnpm local:secrets:init` / `local:secrets:unseal` keep the
  shares in the git-ignored `.local/` folder. They refuse to run without
  `LOCAL_DEV_MODE=true`: keeping all shares in one file defeats the
  splitting, which is fine for fake local data only. `pnpm local:reset`
  deletes the data and the saved shares (old data encrypted under the
  previous environment-variable key can't be used and needs one reset).
- **CI's e2e tests** initialise the fresh stack with brand-new shares and
  unseal it in the test process's memory. The shares are never printed,
  saved or uploaded.
- **Deployments** leave the service sealed after every restart. The smoke
  test expects that (it checks for `503 SECRETS_SEALED`), and the deploy log
  and run summary say an operator must unseal. Storage checks run as before.
  No shares exist in GitHub or the deployment scripts.

## Trade-offs

- **Availability vs. safety:** every restart needs 3 people (or 3 shares) to
  bring secrets back, and secrets are unavailable until then. That is the
  price of never storing the key. With rolling deployments or several nodes
  this manual step becomes painful; **Phase 8 revisits it** (e.g. auto-unseal
  through a KMS, or unsealing each new node from an already-unsealed one).
- **Loss is permanent:** losing 3 or more shares makes every secret
  unrecoverable. There is no recovery key by design. Share custody (who
  holds what, where) is now an operational responsibility.
- **Memory is the weak point:** while unsealed, the master key is in the
  process's memory. Root on the host (or a memory-dumping exploit) can read
  it. Sealing, disabled core dumps and the hardened container reduce, but
  don't remove, that risk.
- **Shares are re-issued only by re-initialising** (no "rekey" yet).

## Compared with a cloud KMS (e.g. AWS KMS)

With a KMS, the master key would be encrypted by a key that never leaves
the KMS's hardware. The service would ask the KMS to decrypt it at startup
("auto-unseal"), with access controlled by IAM roles and every use recorded
in CloudTrail.

|                            | Shamir sealed startup (this)   | Cloud KMS                                                   |
| -------------------------- | ------------------------------ | ----------------------------------------------------------- |
| Works locally, without AWS | Yes                            | No (needs AWS, or an emulator)                              |
| Restarts                   | Manual: 3 shareholders         | Automatic                                                   |
| Who can unlock             | Any 3 of 5 people, together    | Whoever has the IAM permission                              |
| Key material               | Shares held by people, offline | Inside the KMS's HSMs, never exported                       |
| Audit trail                | Our own (none yet)             | Every use logged (CloudTrail)                               |
| Main risk                  | Losing shares; slow recovery   | A compromised IAM role can decrypt; depends on the provider |
| Cost / dependency          | None                           | Per-key and per-request fees; tied to one cloud             |

We chose Shamir now because the project is local-first and the shares give
strong protection without any provider. The `KeyProvider` interface keeps
the door open: a KMS-backed provider, or KMS auto-unseal with Shamir shares
kept as a recovery path, can be added later without touching the encryption
code.

# 0014: Encrypted object storage

- Status: Accepted; implemented in Rust by [0033](0033-rust-storage-service.md), with the same file format
- Date: 2026-11-05

## Context

Until now storage wrote each upload to disk as it was. Anyone with the disk,
a backup or a snapshot of the data volume could read every tenant's files.
The secrets service already protects keys well (per-tenant keys, a master
key that only exists in memory while unsealed: ADRs 0011 and 0012), so
storage should use it. This is a single-node prototype: no buckets,
replication, multiple nodes, background repair or range requests.

## Decisions

### Envelope encryption

- Every file gets a **new random 256-bit key** (`crypto.randomBytes`).
- Storage sends that key to the secrets service's internal
  `POST /internal/file-keys/wrap`, which encrypts it with the **tenant's
  key** (AES-256-GCM, AAD = tenant ID and file ID, plus a format and tenant
  key version). Only the wrapped key (65 bytes) is stored, in storage's
  database. To download, storage calls `/internal/file-keys/unwrap`.
- A wrapped key copied to another file or another tenant fails to unwrap
  (the AAD doesn't match).
- The plain file key is only in storage's memory during one upload or
  download, and its buffer is overwritten with zeros afterwards (as far as
  JavaScript allows: Node's crypto may keep internal copies until garbage
  collection).
- The file-key routes need `Authorization: Bearer INTERNAL_SERVICE_TOKEN`,
  compared in constant time (SHA-256 of both, then `timingSafeEqual`).
  Only storage has the token; the gateway doesn't, and no public route maps
  to them. A wrong token is `403`, even while sealed.
- While the secrets service is sealed it can't wrap or unwrap, so uploads
  and downloads get `503 SECRETS_SEALED`. Listing, metadata, usage and
  delete only need storage's database and keep working.

So the chain is: 3 of 5 shares → unseal key → master key → tenant key →
file key → file. Each step is only useful with the one before it.

### Chunk format (version 1)

Encrypting a whole file at once would need it all in memory, and the
authentication tag would only be checked after the last byte, too late for
a streamed download. So files are split into chunks:

```
encrypted file = chunk 0 | chunk 1 | ... | chunk n-1
chunk i        = AES-256-GCM ciphertext of up to 64 KiB plain data | 16-byte tag
nonce i        = 8-byte random prefix (one per file) | i as 4-byte big-endian
AAD i          = JSON ["storage-chunk", 1, tenantId, fileId, i, isLastChunk]
```

- Every chunk but the last holds exactly 64 KiB of plain data. An empty file
  is one empty final chunk, so "no chunks" never happens.
- **Nonces are never reused with a key**: a key belongs to one file, and
  within it the chunk number makes every nonce different (at most 2³²
  chunks).
- The AAD makes every chunk only valid **at its own position, in its own
  file, for its own tenant**, and records whether it is the last one. A
  chunk that is changed, swapped, reordered, moved to another file or
  tenant, or dropped fails its tag. Cutting the file after any chunk fails
  too: the new last chunk was not encrypted as "last".
- The record stores the format version, chunk size, chunk count, nonce
  prefix, plain and encrypted size and a SHA-256 checksum of the encrypted
  data, so the format can change later (a new version, with a new
  compatibility fixture) without breaking old files.
- Both directions stream, holding about one chunk in memory.

### Saving safely

1. Reserve space in the tenant's limit (one atomic `UPDATE ... WHERE used +
reserved + size <= limit`, so simultaneous uploads can't exceed it).
   Without a `Content-Length`, the maximum upload size is reserved.
2. Create and wrap the file key; insert the record as `uploading`.
3. Encrypt into `/data/.tmp/<random>.part`, `fsync`, then rename it
   atomically to `/data/<tenantId>/<random blob ID>`.
4. Mark the record `ready`, turning the reservation into used space.

Any failure (too large, cancelled, crash) removes the temporary file and the
record and releases the reservation. Only `ready` files are listed or
served. On start-up, storage removes temporary files and unfinished
uploads, finishes interrupted deletes and recalculates usage. Files without
a record are kept and logged, never deleted: a restart or deployment must
not remove data it doesn't own.

### Reading safely

Before sending anything, storage checks the encrypted file's size and
checksum; a mismatch is a `500` with a safe log line. Then each chunk is
decrypted and authenticated **before** it is sent. If a later chunk fails,
the connection is cut, so a client never takes a partial file for a
complete one. Downloads are always `Content-Disposition: attachment` (ASCII
fallback plus RFC 5987 `filename*`), `application/octet-stream` and
`X-Content-Type-Options: nosniff`, so a browser never renders an uploaded
file as a page.

### Deleting

Mark the record `deleting`, remove the encrypted data, then remove the
record (and with it the wrapped key). Each step is safe to repeat, and
start-up finishes any delete a crash interrupted. On SSDs and cloud disks
removing a file is **not physical erasure**: old blocks may remain on the
device. That is acceptable because they hold only ciphertext, and once the
wrapped file key is gone nothing can decrypt them. Destroying the key is
what makes the data unrecoverable.

### What is not encrypted

In storage's own database (`storage`, its own login, like the other
services), in plain text:

- tenant ID, file ID and blob ID;
- the **original filename** and content type (needed for listings and
  downloads; never used on disk);
- plain and encrypted sizes, chunk count and size, nonce prefix, checksum,
  status and timestamps.

Someone with that database learns which tenant stores what names and sizes,
but no content. On disk there are only random names and ciphertext.

## Consequences

- Losing the shares, the secrets database or storage's database loses the
  files. The volume and both databases must be backed up together
  (docs/runbook.md).
- Every upload and download makes one internal call to the secrets service,
  and both stop while it is sealed.
- Files stored before this change have no key and can't be read; locally,
  `pnpm local:reset` clears them.
- A committed test-only fixture (`services/storage/test/fixtures/`, made
  once with a clearly fake key) is decrypted in CI (`compatibility` job) so
  a code change can't silently make existing files unreadable. Gitleaks
  doesn't flag it, so no allowance was added.
- Adding an error code to the two existing file routes is reported by
  oasdiff; it is recorded as a reviewed exception in
  `api/breaking-changes-allowed.txt`.

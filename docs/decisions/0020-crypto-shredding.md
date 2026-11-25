# 0020: Crypto-shredding

- Status: Accepted
- Date: 2026-11-12

## Context

Every file and secret is already encrypted with envelope encryption (ADR
0011, ADR 0014):

```
master key (memory only, after unsealing)
 └─ tenant key: one per workspace, stored wrapped by the master key
     ├─ secret values: encrypted with the tenant key
     └─ file key: one random key per file, stored wrapped by the tenant key
         └─ file data: 64 KiB AES-256-GCM chunks
```

Deleting data the usual way removes rows and files, but copies (backups,
snapshots, a disk taken away) still hold the ciphertext _and_ the wrapped
keys, so they stay decryptable. Laws like Singapore's PDPA expect deleted
personal data to really be gone. The layering above makes a stronger delete
cheap: destroy the key, and every copy of what it protected becomes noise.

## Decisions

### Deleting a file destroys its key first

`markDeleting` (storage) sets the file to `deleting` **and** replaces its
wrapped key with nothing, in one update, before the data is removed. From
that moment the file can't be decrypted, even if the data removal is
interrupted. Deletes stay safe to retry, and start-up cleanup finishes them
as before.

Limit: an older backup of the storage database still has that wrapped file
key, and it can still be unwrapped while the workspace's key exists. Full
protection against old copies comes from deleting the workspace.

### Deleting a workspace destroys its key

Owners delete a workspace from the dashboard (Settings → Delete Workspace,
typing its name to confirm). `DELETE /dashboard/v1/workspaces/{id}`:

1. Refuses (nothing changed) if the secrets service isn't unsealed, or if
   the audit log can't record `tenant.shredded` (platform chain, strict,
   recorded **before** anything is destroyed).
2. Marks the workspace `deleting` and revokes its API keys.
3. The secrets service (`DELETE /internal/tenant`) records the tenant in
   `shredded_tenants` and deletes its key and every secret, in one
   transaction. **The point of no return:** every file key and secret value
   of the workspace, in any copy, can never be decrypted again.
4. Storage (`DELETE /tenant`) destroys every wrapped file key, removes the
   encrypted data and the tenant's folder, then the records.
5. The gateway removes the connections and memberships and marks the
   workspace `deleted` (the row stays so the audit log can name it).

Every step can be repeated. If one fails, the workspace stays `deleting`:
every other route answers `409 CONFLICT`, and the dashboard shows "Workspace
Being Deleted" with **Finish Deletion** for owners.

### A shredded tenant never gets a key again

The secrets service creates a tenant's key the first time it is needed.
After shredding, it checks `shredded_tenants` before creating one, and
answers `404` to unwrapping, so nothing can ever be encrypted for the old
workspace ID again, and a copied wrapped key gets a clear "not found"
rather than a decryption error.

### Same trust as the other internal routes

The gateway calls the two new internal routes like its other calls to these
services (internal network, `X-Tenant-Id` from the verified membership).
They are never reachable through the gateway's public routes. A dedicated
token was considered; the gateway can already delete every secret and file
of a tenant one by one, so it adds plumbing without changing who can do
what. Both are in the internal contracts, with contract tests on both sides.

### Proof

An end-to-end test (`tests/e2e/crypto-shredding.test.ts`) copies a file's
encrypted bytes off the volume and its wrapped key out of the database,
checks the key still unwraps, deletes the workspace, and shows that the
copied key can no longer be unwrapped (404). The copied data therefore can
never be decrypted.

## Consequences

- Deleting a workspace is irreversible by design. The workspace's own audit
  chain is kept (it holds no secret data) and `tenant.shredded` on the
  platform chain proves when and by whom.
- **The guarantee holds only if the secrets database isn't restored from a
  backup taken before the deletion** (that would bring the tenant key
  back). Its backups should be kept short; storage backups are harmless
  without the key. The runbook says so.
- Postgres keeps old row versions until it vacuums; the destroyed values
  aren't readable through any query and are reclaimed by the normal vacuum.
- Not built: undo or a grace period, deleting single users, scheduled
  deletion, key rotation.

# 0021: Secret values are write-only

- Status: Accepted (supersedes the reveal route of ADR 0016 and the Reveal button of ADR 0017)
- Date: 2026-11-12

## Context

The platform's focus is "apps never hold their own keys". Until now a secret
value could still be read back in two ways: `GET /v1/secrets/{name}` (any
API key of the workspace) and the dashboard's owner-only, audited "Reveal".
Every read is a copy of the key leaving the vault, into an app's memory, a
log, a screenshot or a browser. The owner decided: a secret is either never
seen, or rotated to a new one.

## Decisions

- **No client route returns a value.** `GET /v1/secrets/{name}` (and
  `?version=N`) returns the version's metadata (`name`, `version`,
  `createdAt`) and decrypts nothing. The dashboard's reveal route and button
  are gone. A forgotten value is rotated (`POST .../rotate`).
- **Apps use secrets only through injection.** A proxy connection names the
  secret; the gateway fetches the value from the internal
  `/internal/secrets/{name}` for each call and adds it to the outgoing
  request (ADR 0013), never returning it. That internal route is the only
  code that decrypts a secret value; it stays audited (`secret.read`, now
  meaning "read by the platform to inject it").
- **Audit:** reading metadata is not a read of the value, so it records
  nothing. `secret.revealed` stays in the action list so past events remain
  valid and readable.
- **API contract:** removing `value` from the response is a breaking change
  in v1. It is a reviewed exception in `api/breaking-changes-allowed.txt`
  rather than a `/v2`: the platform has no external clients yet, and its
  only client (the demo shop) changes in the same commit. API version 1.7.0.
- **Demo shop:** it dropped its `receipt-signing-key`; it couldn't read it
  anymore, and didn't need to: receipts are stored with storage's
  AES-256-GCM, so a changed file fails authentication and can't be read
  back. Its only secret is the payment key, used through injection.
- **Tests** check values through the injection route or the secret store
  (unit tests), and on the running stack by injecting the value into a call
  to the mock outside API and reading what it received
  (`tests/e2e/helpers.ts`, `injectedValue`). The compatibility fixture is
  still decrypted, through the store, for every version.

## Consequences

- Leaking an API key no longer leaks the secrets it can reach: the key can
  use them only through connections (and their policies, ADR 0019).
- Apps that need a value inside their own code (e.g. to sign something
  locally, or a database password in a connection string) can't get it from
  the platform. They must call outside services through connections, or
  keep such values elsewhere. That limit is deliberate.
- Losing a value is never a recovery problem: rotate it at the outside
  service and save the new one.

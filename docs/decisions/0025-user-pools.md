# 0025: User pools (end-user authentication)

- Status: Accepted; a separate log per user pool, owner unlock and reset at next sign in added ([0036](0036-user-pool-logs-and-password-reset.md))
- Date: 2026-11-16

## Context

Apps built on the platform need their own users to sign up and sign in.
Without that, each app stores passwords itself, or adds another provider
(Cognito, Auth0). The owner chose this as one of two new, separate features
(with feature flags, [0026](0026-feature-flags.md)), with these decisions:

- only the app's **server** calls sign-up and sign-in, with its API key
  (the key never goes to a browser);
- end-user tokens get a **refresh endpoint** (this is the app's token, kept
  by the app; the dashboard's own sessions refresh silently instead,
  [0024](0024-silent-refresh.md));
- each pool's **private signing key is protected by the vault**;
- the demo shop uses it for its shoppers.

## Decision

- **A new internal service, `identity`**, with its own database
  (`identity` / `identity_app`) and audit token, reached only through the
  gateway. The gateway <-> identity contract is
  `api/internal/identity.openapi.json`, with contract tests on both sides.
- **Pools** belong to a workspace and are managed in the dashboard (members
  view, owners change). Each has token lifetimes and a minimum password
  length.
- **Public API (`/v1/user-pools/{poolId}/...`, API key):** sign up, sign in,
  refresh, sign out, read a user, change a password. **Public keys**
  (`GET /v1/user-pools/{poolId}/jwks.json`) need **no** API key: they can
  only verify tokens.
- **Passwords:** Argon2id with the dashboard's settings and common-password
  list; the same 401 for a wrong password, an unknown email (with a dummy
  hash, so the time is the same), a disabled user and a locked one; 5 wrong
  passwords in a row lock a user for 15 minutes.
- **Tokens:** the access token is a JWT signed with **ES256** (ECDSA P-256)
  using Node's built-in crypto (iss, sub, aud = pool, iat, exp, jti,
  token_use, email, the app's attributes). Apps verify it with any JWT
  library and the pool's JWKS. The refresh token is 256 random bits, only
  its SHA-256 stored, and **works once**: every used token is kept (hashed)
  in `used_refresh_tokens`; seeing one again revokes the whole session and
  records `pool_user.token_reused`.
- **Signing keys and the vault:** each pool's private key is encrypted
  (AES-256-GCM, AAD bound to tenant, pool and key ID) with a random data key,
  and the secrets service wraps that data key under the workspace's key
  through new internal routes `/internal/signing-keys/wrap|unwrap`. They need
  their own `IDENTITY_SERVICE_TOKEN` (storage's token can't use them, and the
  identity token can't use the file-key routes); a wrapped signing key can't
  be unwrapped as a file key or for another pool. While the vault is sealed,
  sign-ins answer 503 `SECRETS_SEALED` (sign-ups and verifying existing
  tokens still work). Deleting a workspace crypto-shreds its pools.
- **Owner password reset** gives a random temporary password, shown once
  (there is no email, by the project's rules), and ends the user's sessions.
- **Audit:** pool and user changes are recorded strictly (refused if they
  can't be); sign-ins, failed sign-ins, sign-outs and token reuse best
  effort. Events hold IDs, never emails, passwords or tokens.

## Consequences

- A sixth service in Compose, CI (build, scans, migrations, e2e), the
  deployment workflows, ECR (Terraform) and the stack checks.
- Signing depends on the vault: a sealed platform can't sign anyone in, by
  design (a stolen database can't mint tokens).
- Not built (later phases or out of scope): browser-side sign-in, social or
  enterprise sign-in (SSO), MFA, email verification and reset emails, key
  rotation.

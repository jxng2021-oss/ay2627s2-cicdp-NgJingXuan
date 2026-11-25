# 0026: Feature flags

- Status: Accepted
- Date: 2026-11-16

## Context

The second of the two new, separate features (with user pools,
[0025](0025-user-pools.md)): apps should be able to ship a feature switched
off, then turn it on per environment, for chosen users or a share of them,
without a deployment. The demo shop shows it with a sale banner.

## Decision

- **A new internal service, `flags`**, with its own database (`flags` /
  `flags_app`) and audit token, reached only through the gateway. The
  gateway <-> flags contract is `api/internal/flags.openapi.json`, with
  contract tests on both sides.
- **A flag** has a key (`new-checkout`), a kind (on/off or text), the value
  served while off, and **settings per environment** (development, staging,
  production): on/off, targeting rules, a percentage rollout and a default.
- **Evaluation order** for one user: off -> the first rule whose conditions
  all match (equals, not equals, one of, none of, contains, starts with,
  greater/less than, on the user's key or attributes; optionally only for a
  share of the matching users) -> the percentage rollout -> the default.
  Each answer says why (off, rule N, rollout, default).
- **Stable percentages:** a user's place is a SHA-256 of the flag key and
  the user's key, 0-99.99. The same user always gets the same answer, and
  raising a percentage only adds users. Different flags spread users
  differently.
- **Public API:** one route, `POST /v1/flags/evaluate` (API key): every flag
  (or chosen keys) for one user and environment. Flags are managed in the
  dashboard (members view and test; owners change), where a "Test a User"
  panel makes the same call.
- **No caching:** a change applies to the next evaluation.
- **Audit:** every change is recorded strictly (created, updated, deleted,
  and "toggled" when only on/off changed). Evaluations are counted in a
  metric (`flag_evaluations_total`, by environment and reason), not audited:
  there are far too many.

## Consequences

- A seventh service in Compose, CI, the deployment workflows, ECR and the
  stack checks. Deleting a workspace deletes its flags.
- Not built: flag dependencies, scheduled changes, experiments and
  analytics per variant, approval workflows (approvals are a later phase),
  SDKs with local caching.

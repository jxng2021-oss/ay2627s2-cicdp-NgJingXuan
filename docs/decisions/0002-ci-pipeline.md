# 0002: CI pipeline structure

- Status: Accepted
- Date: 2026-11-03

## Context

Every change to `main` should be checked automatically: style, types, tests,
builds and the full client → gateway → storage path. Security scanning, AWS and
deployments come later and are out of scope here.

## Decision

**GitHub Actions, one workflow (`ci.yml`), triggered by pull requests into
`main` and pushes to `main`.** Pull requests are checked before merging; pushes
to `main` confirm the merged result.

**One job per kind of check** (`lint`, `typecheck`, `unit-tests`, `build`,
`docker-build`, `e2e`), rather than one long job. Jobs run in parallel, so the
pipeline is as slow as its slowest job rather than the sum of all of them, and
a pull request shows exactly which kind of check failed. A failure in one job
doesn't hide failures in the others.

**`e2e` waits for `docker-build`.** It then reuses the image layers that
`docker-build` saved in the GitHub Actions cache instead of building from
scratch, and doesn't start the stack if the images don't build.

**CI only calls root `pnpm` scripts.** The workflow runs `pnpm lint`,
`pnpm typecheck`, `pnpm stack:up` and so on, the same commands as local
development. The one exception is building images: CI uses
`docker buildx bake` on `docker-compose.yml` because it supports the GitHub
Actions layer cache. It builds the same images as `pnpm docker:build`.

**Shared setup in a composite action** (`.github/actions/setup`): pnpm (version
from `packageManager`), Node.js (version from `.nvmrc`), a pnpm store cache
keyed on the lockfile, and `pnpm install --frozen-lockfile`. The Node.js version
is stored in one place, and a lockfile that is out of date with `package.json`
fails the build.

**A single `ci-success` gate job** depends on all other jobs, always runs, and
fails unless every one of them succeeded. Branch protection requires only this
check, so adding or renaming jobs doesn't need a settings change. It treats
"skipped" as a failure on purpose: GitHub counts a skipped required check as
passing, which would let a broken pull request merge.

**Safe defaults:** read-only `contents: read` permissions, a timeout on every
job, and cancelling superseded runs on the same pull request (never on `main`).

## Consequences

- Each job installs dependencies separately. The pnpm store cache keeps this
  fast, and it is the price of parallel, isolated jobs.
- The e2e job depends on Docker Compose health checks to know when the stack is
  ready, so services must keep accurate `/health` endpoints and health checks.
- Security scanning, image publishing and deployment will be added as new jobs
  (and new `needs` entries for `ci-success`) in later phases.

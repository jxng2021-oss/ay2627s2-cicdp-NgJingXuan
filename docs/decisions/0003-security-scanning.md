# 0003: Security scanning in CI

- Status: Accepted
- Date: 2026-11-03

## Context

The platform will hold secrets and user files, so risky changes should be
blocked before they merge, not found later. We want free, widely used,
open-source scanners that need no accounts or tokens and that developers can run
locally with the same results as CI.

## Decision

Four scan jobs run in `.github/workflows/ci.yml`, alongside the other checks,
and all of them feed the `ci-success` gate.

| Job               | Tool     | Scans                                         |
| ----------------- | -------- | --------------------------------------------- |
| `secret-scan`     | Gitleaks | Full Git history (`fetch-depth: 0`)           |
| `code-scan`       | Semgrep  | Source, Dockerfiles, Compose and CI workflows |
| `dependency-scan` | Trivy    | `pnpm-lock.yaml`, including dev dependencies  |
| `image-scan`      | Trivy    | The built gateway and storage images          |

**Why these tools.** Gitleaks is the standard open-source secret scanner and
reads Git history directly. Semgrep's free community rulesets cover TypeScript,
Node.js, Dockerfiles, Docker Compose and GitHub Actions, and its rules are
readable YAML. Trivy covers both lockfiles and container images with one tool
and one vulnerability database.

**Run in Docker, through one script.** `scripts/security-scan.ts` runs each tool
from an image pinned by version and digest, and applies the failure rules. CI
calls the same `pnpm scan:*` scripts as developers, so a scan can't pass locally
and fail in CI (or the reverse) because of a different tool version.
Third-party GitHub Actions are pinned to full commit SHAs for the same reason: a
tag can be moved to different code, a SHA or digest can't.

## Failure rules

- **Secrets:** any finding fails. Gitleaks does not verify whether a key is
  live, so every likely secret is treated as real.
- **Code:** Semgrep findings at ERROR severity fail. Lower severities are printed
  and saved in the report, but don't block.
- **Dependencies and images:** HIGH or CRITICAL vulnerabilities that have a
  fixed version fail. Everything else, including vulnerabilities with no fix
  yet, is printed as a table but doesn't block, because there is nothing to
  upgrade to.
- No scanner step uses `continue-on-error`. A scanner crashing fails its job.

## Reports

Each job uploads its JSON report as a workflow artifact, kept for 7 days. The
reports can't contain secret values: Gitleaks runs with `--redact` and the
script keeps only the rule, file, line and commit; Semgrep's matched source
lines are deleted; Trivy only records package names and versions.

## Handling a finding

1. **Assume it is real and fix the cause.** For a secret, rotate it first
   (removing it from the code doesn't un-leak it), then remove it. For code, change
   the pattern. For a vulnerability, upgrade the package or the base image, or
   remove the vulnerable component (as we did with npm in the runtime images).
2. **Only for a genuine false positive**, add the narrowest possible ignore,
   with a comment explaining why it is safe:
   - Gitleaks: a `gitleaks:allow` comment on that line. For a finding in an old
     commit, add only that finding's fingerprint to `.gitleaksignore`.
   - Semgrep: a `nosemgrep: <rule-id>` comment on that line, naming the one rule.
   - Trivy: the single CVE ID in `.trivyignore`, with a comment, and ideally an
     `exp:` date so the ignore is reviewed again.
3. Never ignore a whole file, directory, rule set or severity level, and never
   lower the thresholds to get a pass.

## Consequences

- The dependency and image scans can start failing without any code change,
  when a new CVE is published. That is intended: it means an upgrade is
  available and should be applied.
- The free Semgrep rules mostly model Express apps and don't trace Fastify
  request data into dangerous calls such as `exec` or `eval`. Code review and
  tests are still needed. Custom Semgrep rules for this codebase can be added
  later.
- Updating a scanner means changing its version and digest in
  `scripts/security-scan.ts`. Automated update PRs (e.g. Dependabot) can come in
  a later phase.

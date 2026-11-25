# 0007: Local-first development

- Status: Accepted
- Date: 2026-11-04

## Context

The AWS infrastructure and deployment workflows exist (ADRs 0004–0006), but the
AWS account and its settings will only be provided at the end of the project.
Meanwhile the product needs real features (a database, tenants, API keys).
If features could only be tested in AWS, every change would be blocked, and
the app would slowly grow AWS-specific assumptions.

## Decision

**Every feature must build, run and pass its tests locally with Docker
Compose, without an AWS account or credentials.**

- `docker compose up --build` starts the whole stack (Postgres, migrations,
  storage, gateway) with safe local-only defaults, so it works with no setup.
  `.env.example` lists every setting; copying it to `.env` overrides them.
- App code is independent of AWS. Anything that differs between environments
  (database URL, admin token, hashing secret, key prefix, ports) is an
  environment variable. The local Compose file has defaults; the deployment
  Compose file has none and requires every value.
- Unit tests need no Docker at all (the gateway uses an in-memory Postgres).
  The e2e tests and stack checks run against the local Compose stack, in CI
  too.
- The Terraform and the AWS workflows stay valid and up to date: CI still
  formats, validates, tests and scans the Terraform, and actionlint checks the
  workflows. But nothing runs against AWS: the deployment workflows start with
  a check of the repository variable `AWS_DEPLOY_ENABLED` and skip all AWS
  steps, successfully and with an explanation, until it is `true`. They never
  block CI.

## Consequences

- Anyone can clone the repository and run and test everything on their
  machine with only Docker (plus Node and pnpm for the helper scripts).
- Switching AWS on later is a documented, deliberate step (apply Terraform,
  create the GitHub Environments, set `AWS_DEPLOY_ENABLED=true`), not a code
  change.
- Some behaviour can only be fully proven once AWS exists (OIDC sign-in,
  Systems Manager, ECR). The deployment scripts are rehearsed locally against
  stand-ins, but the first real deployment still needs care.
- Local defaults are clearly labelled local-only and are not accepted by the
  deployment Compose file, so they can't silently reach a server.

# 0032: A simpler project: no Terraform, no monitoring stack, layered services, one tests folder, no comments

- Status: Accepted; automatic deployment brought back by [0035](0035-automatic-deployment-ecr-ssm.md) (still no Terraform or monitoring stack)
- Date: 2026-11-19

## Context

The owner found the project too complicated to follow and asked to remove
the complicated parts, make every service follow the same flow, put all
tests in one place, and remove the comments from the code. Their choices:

- **Deployment:** a manual EC2 server with a simple deploy script, instead
  of Terraform and the AWS deployment workflows;
- **Monitoring:** all of it goes, including each service's `/metrics`;
- **Comments:** removed from code, except those tools need;
- **Tests:** one root `tests/` folder with a subfolder per part.

## Decision

- **Removed:** `infra/` (Terraform), the AWS workflows (deploy-staging,
  deploy-production, deploy-release, rollback, aws-gate), the runner-side
  deploy scripts (run-remote, find-instance, ecr-release, release-info), the
  `terraform` and `iac-scan` CI jobs; `monitoring/` (Prometheus, Grafana,
  alert rules), the `monitoring` CI job, prom-client and every `/metrics`
  route (ADR 0015's metrics part). Each service still logs one JSON
  `request completed` line per request.
- **Deployment** (docs/deploy-ec2.md): the owner launches an EC2 instance
  and an Elastic IP in the console; `deploy/deploy.sh <domain>` builds the
  images on the server from a clone of the repository (deploy key, read
  only) and starts the stack behind Caddy (ADR 0031). The server's secrets
  are generated once and never printed; the secrets service is unsealed by
  hand as before.
- **Layers:** every service is `routes -> controllers -> services ->
models`. Routes register paths, schemas and hooks; controllers read the
  request, call services and shape the answer (errors from services are an
  `AppError`); services hold the logic and calls to other services; models
  hold every query. The gateway's dashboard code moved into the same
  top-level folders.
- **Tests:** all in `tests/<part>/`, a workspace package (`@platform/tests`)
  holding the test libraries at the services' exact versions. Each part
  still runs from its own package (its Vitest or Playwright config points
  at its folder), and `resolve.dedupe` makes the tests use the same copies
  of the libraries as the code they test.
- **Comments:** removed from code (TypeScript, JavaScript, CSS, shell, SQL,
  Dockerfiles and workflows), keeping only those tools need (lint and type
  suppressions with their reasons, scanner allowances, pinned action
  versions). Generated files (migrations, generated API types) keep theirs.
  Explanations live in the docs and ADRs.

## Consequences

- Infrastructure is no longer code: the server must be recreated by hand
  from the guide, and nothing deploys automatically from CI.
- Building on the server means the deployed images are not the exact ones
  CI scanned; CI still builds and scans the same Dockerfiles.
- Without metrics there are no dashboards or alerts; logs (with request IDs)
  are the only way to see what happened.
- Code without comments relies on clear names and small functions; the
  reasons behind security choices are in the ADRs and CLAUDE.md.

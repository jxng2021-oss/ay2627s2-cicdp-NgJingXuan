# 0005: Automatic staging deployment

- Status: Superseded by [0032](0032-simpler-project.md) (no staging environment) and [0035](0035-automatic-deployment-ecr-ssm.md) (main deploys automatically to the one server)
- Date: 2026-11-03

## Context

Every change merged to `main` should reach staging automatically, be the exact
code CI tested, and be checked once it's running. The staging instance has no
SSH and its security group only admits `allowed_cidr`, and both of those must
stay true. Production promotion, approvals and rollback come later.

## Decisions

**Trigger: `workflow_run` after CI succeeds on `main`.** The deployment
workflow (`.github/workflows/deploy-staging.yml`) starts only when the CI
workflow finishes, and continues only if CI succeeded for a push to `main` in
this repository. It checks out `workflow_run.head_sha`, the commit CI actually
tested, rather than the current tip of `main`, which may have moved on.
Deployments queue one at a time and are never cancelled half-way.

**GitHub OIDC instead of AWS access keys.** Each job asks GitHub for a
short-lived signed token and exchanges it for temporary AWS credentials (about
an hour). There are no long-lived keys to leak, rotate or store as GitHub
secrets. The IAM role trusts only tokens whose subject is exactly
`repo:<owner>/<name>:environment:staging`, so only jobs using the `staging`
GitHub Environment of this repository can deploy. Forks, other branches'
pull requests and other repositories are refused by AWS itself. The role can
only push to our two ECR repositories and send commands to instances tagged
`Project=secure-cloud-platform`, `Environment=staging`, using only the
`AWS-RunShellScript` document.

**Systems Manager instead of SSH or opening the firewall.** Run Command
delivers the Compose file and scripts to the instance and runs them, with no
inbound port, no SSH key and an audit trail in AWS. The smoke test also runs on
the instance through Systems Manager: GitHub's runners are not in
`allowed_cidr`, and we don't want to widen it just for testing. The instance is
found by its tags each time, so rebuilding it needs no change in GitHub.

**Images tagged with the full commit SHA and deployed by digest.** Each image
is built once per commit and tagged with the 40-character SHA (never `latest`),
in repositories whose tags are immutable. The workflow records each image's
digest (its content hash) in the job outputs and summary, and the server pulls
`repo@sha256:…`, so what runs is byte-for-byte what was built. Re-running a
deployment reuses the existing image instead of rebuilding. Later, production
will deploy these same digests without rebuilding, so what was tested on
staging is exactly what goes live.

**Idempotent deploy script with health checks and a time limit.**
`deploy/deploy.sh` checks its inputs, checks that the data volume is mounted,
pulls by digest and runs `docker compose up --wait` with a timeout. On failure
it prints container status and logs. It records the commit and digests in
`/opt/secure-cloud-platform/deployed.json`. Running it again with the same
inputs changes nothing.

## Consequences

- No rollback yet: a failed deployment leaves staging in its failed state until
  a fix is merged or an earlier deployment run is re-run.
- Systems Manager returns at most 24,000 characters of output to the workflow;
  full logs stay on the instance.
- The deploy and smoke-test scripts run as root on the instance, so they are
  reviewed like any other code, and inputs passed to them are validated against
  strict patterns to prevent command injection.

## Later change

See [0032](0032-simpler-project.md): Terraform, the AWS workflows, the monitoring stack and `/metrics` were removed; the server is set up by hand.

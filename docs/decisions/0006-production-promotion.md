# 0006: Promote tested images to production; manual rollback

- Status: Superseded by [0032](0032-simpler-project.md) (no separate production promotion) and [0035](0035-automatic-deployment-ecr-ssm.md) (tested images published to ECR and deployed from main)
- Date: 2026-11-04

## Context

Production must run exactly what staging tested. If production rebuilt its
images, even from the same commit, the result could differ: base images and
packages change over time, and builds aren't guaranteed to be byte-for-byte
reproducible. A passing staging run would then say nothing certain about
production. We also need a safe, controlled way to go back to an earlier
release.

## Decisions

**Promote, never rebuild.** Each commit's images are built once, by the
staging workflow, and identified by digest (a hash of the image content).
Production deploys those same digests. If staging passed, production runs
the identical bytes.

**Record "passed staging" in ECR.** After staging's smoke tests pass, the
workflow adds the tag `staging-passed-<commit>` to the exact images it
deployed. This re-uses the existing manifest, so no new image is pushed, and
ECR checks the digest matches. Tags are immutable, so the record can't be moved
to a different image later. Production resolves a commit to digests and
**refuses** any image without this tag, or whose tag points elsewhere. The
check runs in the reusable workflow from `main` and is decided by the
environment name, so a caller can't switch it off.

**Separate, smaller permissions for production.** Production has its own IAM
role, trusted only by the `production` GitHub Environment. It can read image
details in ECR but can't push, tag or log in to the registry, and it can only
run commands on instances tagged `Environment=production`. The staging role is
likewise limited to staging instances. Staging only gained the ability to add
tags, which uses the same `ecr:PutImage` permission it already needed to push.

**Approval through the GitHub Environment.** Production deployments and
rollbacks run in the `production` environment, so its protection rules (such
as required reviewers) pause them for approval. Required reviewers depend on
the GitHub plan and repository visibility; without them, the staging-passed
check still applies.

**One deployment path.** Staging deployments, production releases and
rollbacks all call one reusable workflow (`deploy-release.yml`) and the same
scripts, so a fix or safety check applies everywhere at once. The procedure
(scripts) comes from the reviewed workflow commit on `main`. The release (images
and its Compose file) comes from the commit being deployed. Only one
deployment or rollback runs per environment at a time.

**Manual rollback, by digest.** A rollback is a deployment of an earlier
commit's images. Before changing anything, the server saves the current
release as `previous-release.json`, and the run summary shows what was replaced
and what runs now. There is no automatic rollback yet: a person decides.

## Consequences

- Rollback restores code, not data. Deployments never touch stored files. Once
  a release changes a data or file format, or adds a database, rolling back
  past it needs a compatibility plan (backwards-compatible changes or
  reversible migrations); that's for a later phase.
- Images that passed staging must stay in ECR to remain rollback targets, so
  the lifecycle policy keeps the newest 100 of them, separately from the
  newest 30 other images.
- GitHub limits `workflow_run` chains to three levels (CI → Deploy staging →
  Deploy production), so further automatic stages would need a different
  trigger.

## Later change

See [0032](0032-simpler-project.md): Terraform, the AWS workflows, the monitoring stack and `/metrics` were removed; the server is set up by hand.

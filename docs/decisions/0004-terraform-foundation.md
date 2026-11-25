# 0004: Terraform foundation on AWS

- Status: Superseded by [0032](0032-simpler-project.md) (no Terraform: one server set up by hand) and [0035](0035-automatic-deployment-ecr-ssm.md) (automatic deployment through ECR and Systems Manager)
- Date: 2026-11-03

## Context

We need the platform's first cloud environments. For now each environment
(staging, production) is a single server; a later phase makes it distributed and
adds deployments. Costs should stay low, nothing should be exposed that doesn't
need to be, and the infrastructure must be reviewable and reproducible.

## Decisions

**Terraform, region `ap-southeast-1` as a variable.** Infrastructure is code:
reviewed in pull requests, checked in CI, and recreated the same way every time.
Terraform is the most widely used tool for this and has a mature AWS provider.
Terraform and the provider are pinned exactly (with committed lock files for
every platform), like our npm packages.

**Folder layout: bootstrap → shared → environments, built from modules.**

- `bootstrap/` creates the state bucket. It can't store its own state in a
  bucket that doesn't exist yet, so it keeps a small local state file.
- `shared/` holds the ECR repositories. Images are built once and promoted, so
  staging and production must pull from the same repositories rather than each
  owning a copy.
- `environments/staging` and `environments/production` call the same `network`
  and `compute` modules. They differ only in variables and in their state file,
  so a mistake in one can't overwrite the other.

**S3 for Terraform state only.** Terraform needs a durable, shared, locked place
for its state, and an S3 bucket is the standard choice on AWS: versioned (to
roll back), encrypted with our own KMS key (state can contain sensitive values),
fully blocked from public access, HTTPS-only, and locked with S3's built-in lock
files (no DynamoDB table needed). That is its only job. Customer data and
product files never go into it, and the platform's encrypted object storage is
our own service, not S3. Keeping it this way keeps a clear line between "tooling
data" and "customer data".

**Network: one VPC, two public subnets, no NAT.** Two Availability Zones are
ready for the distributed phase. NAT gateways (about US$45/month each) and
private subnets are left out until something needs them. The instance is in a
public subnet, so its security group is the main protection:

- inbound only on the gateway port, only from `allowed_cidr`
- `allowed_cidr` is required and can't be `/0`, because the API has no
  authentication yet
- no SSH at all; administration goes through Systems Manager
- outbound only HTTPS, which the instance needs to reach Systems Manager, ECR
  and package downloads. Without NAT or VPC endpoints those are public
  addresses, so this rule is the one documented Trivy ignore (AWS-0104).

**Compute: one hardened EC2 instance.** Amazon Linux 2023 (latest at creation;
upgrades are done deliberately with `-replace`), `t3.micro` by default with
standard CPU credits so bursts can't add charges. IMDSv2 is required with a hop
limit of 1, so the instance's credentials can't be stolen through SSRF or read
by containers. Both disks are encrypted. A separate data volume holds stored
files, so they survive container restarts and instance replacement; the startup
script formats it only if it is empty. The IAM role allows Systems Manager and
read-only pulls from our two repositories. Docker Compose is a pinned release
with its checksum verified.

**ECR: private, immutable tags, scan on push, lifecycle policy.** An immutable
tag always refers to the same image, which makes deployments repeatable.
Untagged images go after 7 days and only the newest 30 are kept, to control
storage costs.

**Checks without AWS access.** CI runs `terraform fmt -check`,
`init -backend=false`, `validate` and `terraform test` (against a mock AWS
provider) on every folder, and a Trivy misconfiguration scan that fails on
HIGH/CRITICAL findings. None of this needs AWS credentials.

## Accepted findings (shown in CI, not blocking)

- S3 access logging, VPC flow logs and customer-managed KMS keys for EBS/ECR
  (LOW/MEDIUM). They add cost and are worth revisiting with monitoring in a
  later phase.

## Consequences

- Applying is manual for now (see `infra/README.md`); deployment workflows and
  GitHub OIDC come later.
- The public IP changes if the instance is stopped and started; a load balancer
  or Elastic IP can fix that later.
- Bootstrap's local state file must be kept safe by whoever applies it.

## Later change

See [0032](0032-simpler-project.md): Terraform, the AWS workflows, the monitoring stack and `/metrics` were removed; the server is set up by hand.

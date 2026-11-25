# Architecture decision records

Each record explains one significant decision: the context, what was decided
and what follows from it. Records are never rewritten after the fact: when a
later decision changes an earlier one, the earlier record's status line says
so and links to the newer record.

- **Accepted:** the decision stands as written.
- **Updated:** the decision stands, and a later record changed part of it
  (see the status line at the top of the record).
- **Superseded:** a later record replaced the decision.

Records 0001 to 0032 were written while the platform was first built (in an
earlier repository) and moved here unchanged apart from their status lines;
records 0033 onwards were written in this repository.

| ADR                                                     | Decision                                                                                              | Status     | Date       |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------- | ---------- |
| [0001](0001-monorepo-and-stack.md)                      | Monorepo, TypeScript with Fastify, and Next.js for the frontend                                       | Accepted   | 2026-11-03 |
| [0002](0002-ci-pipeline.md)                             | CI pipeline structure                                                                                 | Accepted   | 2026-11-03 |
| [0003](0003-security-scanning.md)                       | Security scanning in CI                                                                               | Accepted   | 2026-11-03 |
| [0004](0004-terraform-foundation.md)                    | Terraform foundation on AWS                                                                           | Superseded | 2026-11-03 |
| [0005](0005-staging-deployment.md)                      | Automatic staging deployment                                                                          | Superseded | 2026-11-03 |
| [0006](0006-production-promotion.md)                    | Promote tested images to production; manual rollback                                                  | Superseded | 2026-11-04 |
| [0007](0007-local-first.md)                             | Local-first development                                                                               | Accepted   | 2026-11-04 |
| [0008](0008-api-key-authentication.md)                  | Tenants and API key authentication                                                                    | Accepted   | 2026-11-04 |
| [0009](0009-gateway-protections.md)                     | Gateway protections: rate limits, request limits, request IDs, errors                                 | Accepted   | 2026-11-04 |
| [0010](0010-api-versioning-and-contracts.md)            | API versioning, OpenAPI and contract tests                                                            | Accepted   | 2026-11-04 |
| [0011](0011-secrets-encryption.md)                      | Secrets service and encryption                                                                        | Updated    | 2026-11-04 |
| [0012](0012-sealed-startup.md)                          | Sealed startup for the secrets service                                                                | Updated    | 2026-11-04 |
| [0013](0013-secret-injection.md)                        | Secret injection through a proxy route                                                                | Accepted   | 2026-11-05 |
| [0014](0014-encrypted-storage.md)                       | Encrypted object storage                                                                              | Updated    | 2026-11-05 |
| [0015](0015-audit-and-monitoring.md)                    | Tamper-evident audit log and basic local monitoring                                                   | Updated    | 2026-11-05 |
| [0016](0016-dashboard-auth.md)                          | Dashboard accounts, sessions and CSRF protection                                                      | Updated    | 2026-11-05 |
| [0017](0017-dashboard-frontend.md)                      | The dashboard frontend                                                                                | Updated    | 2026-11-12 |
| [0018](0018-demo-shop.md)                               | A demo shop as a pretend customer                                                                     | Updated    | 2026-11-12 |
| [0019](0019-connection-policies.md)                     | Policies on proxy connections                                                                         | Updated    | 2026-11-12 |
| [0020](0020-crypto-shredding.md)                        | Crypto-shredding                                                                                      | Accepted   | 2026-11-12 |
| [0021](0021-write-only-secrets.md)                      | Secret values are write-only                                                                          | Updated    | 2026-11-12 |
| [0022](0022-hashicorp-style-ui.md)                      | A HashiCorp-style UI, a landing page and split sign-in pages                                          | Updated    | 2026-11-15 |
| [0023](0023-workspace-analytics.md)                     | Workspace analytics from the audit log                                                                | Accepted   | 2026-11-15 |
| [0024](0024-silent-refresh.md)                          | Silent session refresh on the server                                                                  | Updated    | 2026-11-16 |
| [0025](0025-user-pools.md)                              | User pools (end-user authentication)                                                                  | Updated    | 2026-11-16 |
| [0026](0026-feature-flags.md)                           | Feature flags                                                                                         | Accepted   | 2026-11-16 |
| [0027](0027-navbar-theme-and-account.md)                | Navbar, theme switch and account management                                                           | Accepted   | 2026-11-16 |
| [0028](0028-landing-design-system.md)                   | The landing page and UI follow landingdesign.md                                                       | Accepted   | 2026-11-16 |
| [0029](0029-sdk.md)                                     | A Node.js SDK and its docs on the website                                                             | Updated    | 2026-11-16 |
| [0030](0030-user-pool-roles.md)                         | Roles and permissions in user pools                                                                   | Accepted   | 2026-11-16 |
| [0031](0031-https-with-caddy.md)                        | HTTPS on the servers with Caddy and an Elastic IP                                                     | Updated    | 2026-11-17 |
| [0032](0032-simpler-project.md)                         | A simpler project: no Terraform, no monitoring stack, layered services, one tests folder, no comments | Updated    | 2026-11-19 |
| [0033](0033-rust-storage-service.md)                    | The storage service in Rust, and its libraries                                                        | Accepted   | 2026-11-21 |
| [0034](0034-rust-secrets-service-and-shamir-port.md)    | The secrets service in Rust, and a port of the audited Shamir library                                 | Accepted   | 2026-11-22 |
| [0035](0035-automatic-deployment-ecr-ssm.md)            | Automatic deployment through ECR and Systems Manager                                                  | Accepted   | 2026-11-22 |
| [0036](0036-user-pool-logs-and-password-reset.md)       | A separate log per user pool, owner unlock and reset at next sign in                                  | Accepted   | 2026-11-23 |
| [0037](0037-dashboard-sessions-30-day-refresh.md)       | Dashboard sessions renew for 30 days while in use                                                     | Accepted   | 2026-11-23 |
| [0038](0038-dashboard-google-github-sign-in.md)         | Continue with Google or GitHub for dashboard accounts                                                 | Accepted   | 2026-11-23 |
| [0039](0039-demo-shop-pays-with-stripe.md)              | The demo shop pays with Stripe (test mode)                                                            | Accepted   | 2026-11-23 |
| [0040](0040-payment-webhooks-signed-by-secure-cloud.md) | Payment webhooks, checked by secure-cloud and signed with its own key                                 | Accepted   | 2026-11-24 |

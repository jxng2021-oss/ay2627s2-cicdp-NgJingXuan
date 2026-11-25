# secure-cloud

A secure cloud platform for developers' apps. A dev app (for example an
online shop) uses one versioned API, `/v1`, with an API key to:

- **keep secrets** that nobody can read back: values are encrypted with a key
  per workspace, and the master key exists only in memory after 3 of 5 key
  holders unseal the service;
- **store files encrypted** before they reach the disk;
- **call outside APIs** (payments, email, AI) through connections that add the
  stored key on the way out, with optional limits on routes, calls and amounts;
- **receive payment webhooks** from Stripe, checked and re-signed by
  secure-cloud;
- **sign its own users up and in** with user pools (ES256 tokens, roles);
- **turn features on** for chosen users with feature flags;
- **see a tamper-evident audit log** of everything sensitive.

Workspace owners manage it all from a web dashboard; dev apps use it through
the Node.js SDK.

- Live dashboard: https://securee-cloud.duckdns.org
- Live API: https://api.securee-cloud.duckdns.org
- QA report: https://jxng2021-oss.github.io/ay2627s2-cicdp-NgJingXuan/

## Architecture

```
Internet ─► Caddy (HTTPS) ─┬─► API gateway (Fastify) ─┬─► secrets  (Rust)
                           │                          ├─► storage  (Rust)
                           └─► dashboard (Next.js)    ├─► audit    (Fastify)
                                                      ├─► identity (Fastify)
                                                      ├─► flags    (Fastify)
                                                      └─► outside APIs (proxy)
Each service has its own PostgreSQL database and login; Redis holds rate limits.
```

Only the gateway and the dashboard are reachable from outside; every other
service stays on the internal Docker network. Every service is layered the
same way: routes → controllers → services → models.

## Repository

```
apps/dashboard      the dashboard and the SDK docs (Next.js 16, React 19)
apps/demo-shop      a pretend customer shop, for local testing and CI only
packages/sdk        @secure-cloud/sdk, the Node.js SDK
services/           gateway, audit, identity, flags (TypeScript); secrets, storage (Rust)
tests/              every test, one folder per part, plus e2e and browser tests
api/                the public OpenAPI spec and the internal service contracts
deploy/             the server's Compose file, Caddyfile and deploy scripts
docs/               API guide, runbook, deployment guide and decision records
```

## Running it locally

Needs Node.js 22.19+, pnpm 10, Rust (from `rust-toolchain.toml`) and Docker.
No AWS account is needed.

```sh
pnpm install
cp .env.example .env
pnpm local:start                              # the whole stack in Docker
LOCAL_DEV_MODE=true pnpm local:secrets:init   # once: initialise and unseal
```

Then open http://localhost:3000 for the dashboard; the API is on
http://127.0.0.1:8080. After every restart:
`LOCAL_DEV_MODE=true pnpm local:secrets:unseal`. The demo shop:
`LOCAL_DEV_MODE=true pnpm demo:setup`, then http://localhost:3100.

`pnpm local:stop` stops the stack and keeps the data; `pnpm local:reset`
deletes it.

## Trying it with curl

In the dashboard, create a workspace and an API key (**API keys → Create API
key**), then:

```sh
KEY=<your API key>
API=http://127.0.0.1:8080            # or https://api.securee-cloud.duckdns.org

# save a secret (write-only: no route ever returns its value)
curl -X PUT "$API/v1/secrets/db-password" -H "Authorization: Bearer $KEY"   -H "Content-Type: application/json" -d '{"value":"example-value"}'
curl "$API/v1/secrets/db-password" -H "Authorization: Bearer $KEY"   # metadata only

# upload a file (encrypted before it reaches the disk), list it, download it
curl -X POST "$API/v1/storage/files" -H "Authorization: Bearer $KEY"   -H "Content-Type: text/plain" -H "X-File-Name: hello.txt" --data-binary "hello"
curl "$API/v1/storage/files" -H "Authorization: Bearer $KEY"
curl "$API/v1/storage/files/<file id>" -H "Authorization: Bearer $KEY"

# what happened, from the tamper-evident audit log
curl "$API/v1/audit-events?limit=10" -H "Authorization: Bearer $KEY"
```

Every route, error and limit is in the [API guide](docs/api.md).

## Checks

```sh
pnpm lint              # ESLint, Prettier, rustfmt and clippy
pnpm typecheck         # strict TypeScript everywhere
pnpm test              # unit and contract tests (the Rust secrets tests need a
                       # PostgreSQL DATABASE_URL, as in CI)
pnpm test:coverage     # the same with coverage (once: pnpm test:coverage:install)
pnpm test:compat       # data encrypted by earlier versions still decrypts
pnpm e2e:start         # build and start the stack for the tests below
pnpm test:e2e          # end-to-end tests against the running stack
pnpm test:ui           # dashboard browser tests (Playwright + axe)
pnpm test:demo         # demo shop browser tests
pnpm api:check         # the committed OpenAPI specs match the code
pnpm qa:report         # build the QA report from the results above (qa/report/)
pnpm api:breaking      # no breaking change to /v1
pnpm scan:secrets      # Gitleaks; also scan:code (Semgrep), scan:deps and
                       # scan:images (Trivy), scan:rust (cargo audit)
```

## CI/CD

One GitHub Actions pipeline (`.github/workflows/ci.yml`) runs on every pull
request to `main`: lint, types, unit and contract tests with coverage, the
encryption compatibility check, migrations, API spec and breaking-change
checks, secret, code, dependency and image scans, Docker builds, and the
end-to-end and browser tests against the whole stack. A single check,
**All checks passed**, is required before merging.

On `main`, the pipeline also publishes the tested images to Amazon ECR and
deploys them to the EC2 server through AWS Systems Manager, with no stored AWS
keys (GitHub OIDC).

## Documentation

- [API guide](docs/api.md): authentication, routes, errors, limits, versioning
- [Runbook](docs/runbook.md): unsealing, health checks, settings, rolling back
- [QA report](https://jxng2021-oss.github.io/ay2627s2-cicdp-NgJingXuan/): built by the pipeline from every run on `main`
  (tests, coverage, scans and quality gates), published on GitHub Pages
- [Deploying to EC2](docs/deploy-ec2.md): setting the server up
- [Architecture decision records](docs/decisions/README.md): why it is built
  this way (41 records)
- [Demo shop: local or live](docs/demo-shop-targets.md)
- [Continue with Google and GitHub](docs/google-github-sign-in.md)
- [CHANGELOG](CHANGELOG.md): every change to the public API
- SDK docs: `/docs` on the dashboard

## Working on it

- Branch from `main` (`feature/…`, `fix/…`, `docs/…`) and open a pull request.
- Commit messages: `type(scope): summary [KAN-n]`, for example
  `fix(gateway): accept longer Google access tokens [KAN-154]`, where `KAN-n`
  is the Jira story.
- Never commit secrets; put new settings in `.env.example`.

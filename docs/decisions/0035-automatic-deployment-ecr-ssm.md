# 0035: Automatic deployment through ECR and Systems Manager

- Status: Accepted
- Date: 2026-11-22
- Replaces: the "no automatic deployment" rule (the platform's earlier ADR 0032)

## Context

The platform runs on one EC2 server with Docker Compose and Caddy. Until now
an operator deployed by hand: SSH in, `git pull`, then `deploy/deploy.sh`,
which built every image on the server.

That had three problems for a CI/CD project:

- a change on `main` only reached the server when someone remembered to
  deploy it;
- the server ran images it had just built itself, not the ones CI tested;
- building two Rust services and two Next.js apps on a `t3.small` took 15 to
  25 minutes and needed swap.

## Decision

Every push to `main` that passes CI deploys itself:

```
push to main → CI (every job) → ci-success → publish → deploy
```

- **publish** builds the seven server images from the same Docker layer
  cache the `docker-build` job filled while CI tested them, and pushes them
  to Amazon ECR tagged with the commit SHA.
- **deploy** asks AWS Systems Manager to run, on the instance:
  `git checkout --detach <sha>`, then `deploy/deploy.sh <domain>` with
  `IMAGE_REPOSITORY` and `IMAGE_TAG` set. The script logs in to ECR with the
  instance's role, pulls the images for that commit and restarts only the
  containers that changed. It refuses to run if the deploy files and the
  images are from different commits.
- Only one deploy runs at a time, and a running deploy is never cancelled.
- Both jobs skip themselves until the AWS variables are set, and never run
  for pull requests.

### Credentials

There are no long-lived keys anywhere:

- GitHub gets short-lived AWS credentials through OIDC. The IAM role trusts
  only `repo:jxng2021-oss@261221037/ay2627s2-cicdp-NgJingXuan@1437998972:ref:refs/heads/main`
  (GitHub's immutable subject: a deleted and recreated repository with the
  same name gets new IDs, so it cannot take over the role), and
  may only push to the seven ECR repositories and run `AWS-RunShellScript`
  on this one instance.
- The instance pulls from ECR with its own instance role.
- Systems Manager needs no inbound port, so SSH stays limited to the
  operator's IP.

### Why not the alternatives

| Option                          | Why not                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| Keep building on the server     | Slow, memory hungry, and the server would not run the exact images CI tested                 |
| GitHub Container Registry       | The server would need a stored GitHub token; ECR uses the instance role                      |
| SSH from GitHub Actions         | GitHub's runners connect from changing addresses, so SSH would have to be open beyond one IP |
| A self-hosted runner on the EC2 | Extra software with sudo on the server to keep patched                                       |

## Consequences

- Deploys take a few minutes and ship the tested images, identified by
  commit SHA. Rolling back is redeploying an older SHA.
- **Unsealing stays manual, on purpose.** Shares are never stored where an
  automated job could use them. Most deploys leave the secrets container
  running; a change to the secrets service itself restarts it sealed, and
  the deploy job reports a warning so three operators unseal it.
- The manual path still works: without `IMAGE_REPOSITORY`, `deploy.sh`
  builds on the server as before.
- AWS resources (ECR repositories, the OIDC role, the instance role) are set
  up by hand in the console (docs/deploy-ec2.md); there is still no
  Terraform.
- The two Rust images now cache their dependencies in their own layer
  (cargo-chef), so a code change rebuilds only the service itself.

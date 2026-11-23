# Deploying to EC2 automatically (ECR + Systems Manager)

Every push to `main` that passes CI is deployed automatically (ADR 0035):

```
push to main → 1.x and 2.x checks → 3. All checks passed → 4. Publish images to ECR → 5. Deploy to EC2 (Systems Manager runs deploy.sh)
```

The server runs everything with Docker Compose. Caddy is the only thing the
internet reaches: the dashboard at `https://<domain>` and the API at
`https://api.<domain>`, with Let's Encrypt certificates.

This page sets it up once. Replace `ACCOUNT_ID`, `INSTANCE_ID` and `NAME`
(your DuckDNS name) as you go; the region is `ap-southeast-1`.

**Cost:** a `t3.small` with a 30 GB disk and an Elastic IP is about US$1 a
day. ECR storage is a few cents. Tear it down when you are done (last
section).

## 1. ECR repositories

ECR → **Create repository**, seven times, **Private**, with these names:

```
secure-cloud-platform/gateway     secure-cloud-platform/storage
secure-cloud-platform/secrets     secure-cloud-platform/audit
secure-cloud-platform/identity    secure-cloud-platform/flags
secure-cloud-platform/dashboard
```

For each: **Tag immutability: Mutable** (a re-run of the same commit
re-pushes its tag), **Scan on push: on**. Then **Lifecycle policy → Create
rule**: image count more than **30**, any tag → expire.

## 2. GitHub as an identity provider

IAM → **Identity providers → Add provider** → OpenID Connect:

- Provider URL: `https://token.actions.githubusercontent.com`
- Audience: `sts.amazonaws.com`

## 3. The instance's role

IAM → **Roles → Create role** → AWS service, use case **EC2** → attach
`AmazonSSMManagedInstanceCore` and `AmazonEC2ContainerRegistryReadOnly` →
name it `secure-cloud-instance`.

## 4. Launch the server

EC2 → **Launch instance**:

| Setting                                 | Value                                                                            |
| --------------------------------------- | -------------------------------------------------------------------------------- |
| Name                                    | `secure-cloud`                                                                   |
| Image                                   | Ubuntu Server 24.04 LTS (x86_64); it includes the Systems Manager agent          |
| Instance type                           | `t3.small`                                                                       |
| Key pair                                | create one (`.pem`), keep it safe                                                |
| Security group                          | **SSH 22 from My IP**, **HTTP 80** and **HTTPS 443 from Anywhere**. Nothing else |
| Storage                                 | 30 GB gp3                                                                        |
| IAM instance profile (Advanced details) | `secure-cloud-instance`                                                          |

Then EC2 → **Elastic IPs → Allocate** → **Associate** with the instance.
Note the instance ID (`i-…`).

On [duckdns.org](https://www.duckdns.org), point `NAME` at the Elastic IP.
`api.NAME.duckdns.org` follows automatically. Check:
`nslookup api.NAME.duckdns.org`.

## 5. Prepare the server

```sh
ssh -i secure-cloud.pem ubuntu@<elastic-ip>

curl -fsSL https://get.docker.com | sudo sh
sudo snap install aws-cli --classic

# 2 GB of swap, only needed if you ever build on the server by hand
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# A read-only key for cloning the private repository
ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519
cat ~/.ssh/id_ed25519.pub
```

GitHub → the repository → **Settings → Deploy keys → Add deploy key**,
paste it, **leave write access off**. Then:

```sh
git clone git@github.com:jxng2021-oss/ay2627s2-cicdp-NgJingXuan.git ~/secure-cloud
```

Check that Systems Manager sees the instance: AWS console → Systems Manager
→ **Fleet Manager** → the instance is listed as **Online**.

## 6. The deploy role for GitHub Actions

IAM → **Roles → Create role** → **Web identity** → provider
`token.actions.githubusercontent.com`, audience `sts.amazonaws.com` → name
it `secure-cloud-github-deploy`. Then **Trust relationships → Edit** and
replace it with (only this repository's `main` branch may use the role).

The repository uses GitHub's immutable subject format, which adds the owner's
and the repository's numeric IDs. Check the exact prefix with
`gh api repos/jxng2021-oss/ay2627s2-cicdp-NgJingXuan/actions/oidc/customization/sub`
(`sub_claim_prefix`); a subject that does not match gives
"Not authorized to perform sts:AssumeRoleWithWebIdentity".

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:jxng2021-oss@261221037/ay2627s2-cicdp-NgJingXuan@1437998972:ref:refs/heads/main"
        }
      }
    }
  ]
}
```

**Permissions → Add permissions → Create inline policy → JSON** (push to the
seven repositories, run the deploy on this one instance, read its result):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EcrLogin",
      "Effect": "Allow",
      "Action": "ecr:GetAuthorizationToken",
      "Resource": "*"
    },
    {
      "Sid": "EcrPush",
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability",
        "ecr:BatchGetImage",
        "ecr:CompleteLayerUpload",
        "ecr:GetDownloadUrlForLayer",
        "ecr:InitiateLayerUpload",
        "ecr:PutImage",
        "ecr:UploadLayerPart"
      ],
      "Resource": "arn:aws:ecr:ap-southeast-1:ACCOUNT_ID:repository/secure-cloud-platform/*"
    },
    {
      "Sid": "RunDeploy",
      "Effect": "Allow",
      "Action": "ssm:SendCommand",
      "Resource": [
        "arn:aws:ec2:ap-southeast-1:ACCOUNT_ID:instance/INSTANCE_ID",
        "arn:aws:ssm:ap-southeast-1::document/AWS-RunShellScript"
      ]
    },
    {
      "Sid": "ReadDeployResult",
      "Effect": "Allow",
      "Action": "ssm:GetCommandInvocation",
      "Resource": "*"
    }
  ]
}
```

## 7. GitHub variables

The repository → **Settings → Secrets and variables → Actions → Variables**
(variables, not secrets: none of these is a secret):

| Variable              | Value                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| `AWS_REGION`          | `ap-southeast-1`                                                                                            |
| `ECR_REGISTRY`        | `ACCOUNT_ID.dkr.ecr.ap-southeast-1.amazonaws.com`                                                           |
| `AWS_DEPLOY_ROLE_ARN` | `arn:aws:iam::ACCOUNT_ID:role/secure-cloud-github-deploy`                                                   |
| `EC2_INSTANCE_ID`     | `i-…`                                                                                                       |
| `DEPLOY_DOMAIN`       | `NAME.duckdns.org`                                                                                          |
| `DEPLOY_PATH`         | optional; default `/home/ubuntu/secure-cloud`                                                               |
| `PROXY_ALLOWED_HOSTS` | optional; outside hosts the proxy route may call, e.g. `api.example.com,abc123.mock.pstmn.io` (empty: none) |

Until `AWS_DEPLOY_ROLE_ARN` is set, "4. Publish images to ECR" and "5. Deploy to EC2" skip
themselves.

## 8. The first deploy

GitHub → **Actions → CI/CD pipeline → Run workflow** on `main` (or push to `main`). After
every check passes, **4. Publish images to ECR** pushes the images and **5. Deploy to EC2** runs
`deploy.sh` on the server. The first run also generates the server's
passwords and keys (in `/etc/secure-cloud-platform/secrets.env`, root only,
never printed). Caddy gets the certificates within a minute.

The deploy finishes with a warning that the secrets service is not
initialised. That is the next step.

## 9. Initialise and unseal (on the server)

A shortcut:

```sh
cd ~/secure-cloud
dc() { sudo docker compose --project-directory deploy -f deploy/docker-compose.yml \
  --env-file deploy/.env --env-file /etc/secure-cloud-platform/secrets.env "$@"; }
```

Once, ever:

```sh
dc exec secrets secrets-operator init
```

It prints the **5 unseal shares once**. Give each to a different person (a
password manager each). They are stored nowhere else; losing more than 2
makes every secret and file unrecoverable.

Now, and whenever the secrets service restarts, run this 3 times with 3
different shares (input is hidden):

```sh
dc exec -it secrets secrets-operator unseal
```

Then open `https://NAME.duckdns.org`, sign up and use the dashboard.

## Every later change

Merge to `main`. CI tests it, publishes the images and deploys them; only
the containers that changed restart. If a change restarted the secrets
service, the deploy job ends with the warning **"the secrets service
restarted sealed"**: unseal it as in step 9.

## Checking

```sh
dc ps                              # every container healthy?
dc logs --tail 50 caddy            # "certificate obtained successfully"
sudo bash deploy/smoke-test.sh     # end-to-end check through the gateway
```

## Rolling back

Every commit's images stay in ECR (the last 30). To go back to an earlier
commit `SHA`:

```sh
cd ~/secure-cloud && git fetch && git checkout --detach SHA
sudo AWS_REGION=ap-southeast-1 \
  IMAGE_REPOSITORY=ACCOUNT_ID.dkr.ecr.ap-southeast-1.amazonaws.com/secure-cloud-platform \
  IMAGE_TAG=SHA deploy/deploy.sh NAME.duckdns.org
```

The next push to `main` deploys the newest commit again.

## Building on the server instead (fallback)

Without `IMAGE_REPOSITORY`, `deploy.sh` builds every image on the server as
before (15 to 25 minutes on a `t3.small`, needs the swap):

```sh
cd ~/secure-cloud && git checkout main && git pull
sudo deploy/deploy.sh NAME.duckdns.org
```

## Tearing it down

EC2: terminate the instance, then **release the Elastic IP**. ECR: delete
the seven repositories. IAM: delete the two roles and the identity
provider. GitHub: remove the deploy key and the variables. The data in
`/srv/secure-cloud-data` goes with the instance.

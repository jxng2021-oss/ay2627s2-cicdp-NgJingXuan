# Runbook: operating the live server

Day-to-day operations of secure-cloud on its EC2 server. Setting the server up
the first time is in [deploy-ec2.md](deploy-ec2.md); this page assumes that is
done. Nothing here needs a key, a share or a token to be written down: secrets
live only in the server's files and the operators' password managers.

## Connect and set up the shortcut

```sh
ssh -i ~/.ssh/secure-cloud.pem ubuntu@<server IP>   # port 22 is open to the owner's IP only
cd ~/secure-cloud
dc() { sudo docker compose --project-directory deploy -f deploy/docker-compose.yml \
  --env-file deploy/.env --env-file /etc/secure-cloud-platform/secrets.env "$@"; }
```

If SSH times out, the owner's IP has changed: update the security group's port
22 rule to **My IP** (or use Systems Manager Session Manager).

## Deploying a change

Merge a pull request into `main`. The pipeline tests it, publishes the images
to ECR (tagged with the commit SHA) and deploys them through Systems Manager;
only the containers that changed restart. Nothing is done by hand.

If the deploy job ends with **"the secrets service restarted sealed"**, unseal
it (next section).

## Unsealing the secrets service

The secrets service always starts **sealed**: its master key exists only in
memory, after 3 of the 5 key holders enter their shares. While sealed,
secrets, file uploads and downloads, connections and pool sign in answer
`503 SECRETS_SEALED`; everything else keeps working and the dashboard shows a
banner.

```sh
dc exec secrets secrets-operator status      # sealed or unsealed?
dc exec -it secrets secrets-operator unseal  # 3 times, a different share each time
```

The share is typed at a hidden prompt: never pass it as an argument, never
paste it into a chat, a ticket or a log. `init` runs once in the server's life
(deploy-ec2.md, step 9); losing more than 2 shares makes every secret and file
unrecoverable.

To seal on purpose (for example when a share may have leaked):
`dc exec secrets secrets-operator seal`.

## Checking health

```sh
dc ps                               # every container Up (healthy)
curl -s https://api.<domain>/ready  # {"status":"ready",...}
sudo bash deploy/smoke-test.sh      # end-to-end check through the gateway
dc logs --since 15m gateway         # one JSON line per request, with its request ID
```

A user reporting an error can give the **request ID** from the error message;
`dc logs gateway | grep <request ID>` finds it, and the workspace's audit log
shows the same ID.

Common warnings in the gateway's logs:

| Log message                           | Meaning                                                                                         | What to do                                         |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `sign in with the provider failed`    | A Continue with Google or GitHub sign in failed; `step`, `status` and `providerError` say where | Check that provider's client ID and secret (below) |
| `couldn't reach the sign in provider` | The server couldn't reach Google or GitHub                                                      | Check the server's outbound network                |
| `AUDIT EVENT LOST`                    | An audit event couldn't be saved after retries                                                  | Check the audit service and Postgres               |

## The audit log

Every sensitive action (keys, secrets, files, connections, sign ins, pool and
flag changes, sealing) is recorded once, with an HMAC chained to the previous
event, so any edit or deletion breaks the chain. Events hold IDs, the outcome,
the request ID and the IP: never values, keys or file contents.

- **A workspace's events:** the dashboard's **Audit log** page (filter by
  action, outcome, resource and time), or `GET /v1/audit-events` with the
  workspace's API key. A user pool's events are on **User activity**.
- **Finding a request:** filter by the request ID the user reported, or
  `dc logs gateway | grep <request ID>` for the matching log line.
- **Checking nothing was changed:** verify every chain (each workspace, each
  user pool and the platform's own):

  ```sh
  dc exec audit node dist/verify.js --all
  ```

  It reports any chain whose hashes don't match. The audit database login can
  only insert and read rows, so a mismatch means the database was changed
  outside the platform: treat it as an incident.

## Changing a server setting

The server's own secrets (database passwords, the Google and GitHub client
secrets) live in `/etc/secure-cloud-platform/secrets.env`, readable by root
only. Dev apps' keys, such as a Stripe key, are not here: workspaces store
them in secure-cloud's secrets service. Other settings have defaults in
`deploy/docker-compose.yml`.

```sh
sudo cp /etc/secure-cloud-platform/secrets.env /etc/secure-cloud-platform/secrets.env.bak
sudo nano /etc/secure-cloud-platform/secrets.env
dc up -d gateway          # restart only the service that reads the setting
sudo rm /etc/secure-cloud-platform/secrets.env.bak   # once it works
```

Restart only what needs it: restarting the secrets service seals it.

Repository variables used by the deploy (GitHub → Settings → Variables), for
example `PROXY_ALLOWED_HOSTS` (the outside hosts connections may call), are
applied on the next deploy.

## Rolling back

Every commit's images stay in ECR (the last 30). To go back to commit `SHA`:

```sh
cd ~/secure-cloud && git fetch && git checkout --detach SHA
sudo AWS_REGION=<region> IMAGE_REPOSITORY=<ECR registry>/secure-cloud-platform \
  IMAGE_TAG=SHA deploy/deploy.sh <domain>
```

The next merge to `main` deploys the newest commit again. Migrations are never
undone automatically: before rolling back past a commit that added a
migration, check that the older code still works with the newer schema.

## Rotating a leaked secret

- **A dev app's secret** (for example a Stripe key): the workspace owner rotates
  it in the dashboard (**Secrets → the secret → Rotate**); connections use the
  new version on their next call.
- **An API key:** the owner revokes it in **API keys** and creates a new one; a
  revoked key is refused at once.
- **A Google or GitHub client secret:** create a new one in the provider's
  console, change it in `secrets.env` as above, restart the gateway, then
  delete the old one in the provider's console.
- Encryption keys (master, tenant, file) can't be rotated yet (future work).

## Disk space

Each workspace may store 1 GiB (`STORAGE_QUOTA_BYTES`) on a 30 GB disk shared
with the system, the images and the databases. Check with `df -h /` and
`sudo docker system df`; `sudo docker image prune -a` removes old images that
no container uses. To allow more, grow the disk and the limit together.

## Tearing it down

See [deploy-ec2.md](deploy-ec2.md#tearing-it-down): terminate the instance,
release the Elastic IP, delete the ECR repositories, the IAM roles and the
identity provider, and remove the GitHub deploy key and variables.

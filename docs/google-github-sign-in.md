# Continue with Google and Continue with GitHub

The dashboard's sign in and sign up pages show a button for each provider
that is set up (docs/decisions/0038). A provider is set up when both its
client ID and client secret are set. They never go in Git, GitHub variables
or this repository.

| Where       | File                                                       |
| ----------- | ---------------------------------------------------------- |
| Your laptop | the root `.env` of the repository (git-ignored)            |
| The server  | `/etc/secure-cloud-platform/secrets.env` (root only, 0600) |

```sh
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
```

Callback addresses to register with the providers:

| Provider | Local                                                           | Server                                                         |
| -------- | --------------------------------------------------------------- | -------------------------------------------------------------- |
| Google   | `http://localhost:8080/dashboard/v1/auth/oauth/google/callback` | `https://api.<domain>/dashboard/v1/auth/oauth/google/callback` |
| GitHub   | `http://localhost:8080/dashboard/v1/auth/oauth/github/callback` | `https://api.<domain>/dashboard/v1/auth/oauth/github/callback` |

## Google

1. <https://console.cloud.google.com> → your project → **APIs and services →
   OAuth consent screen**: External, app name `secure-cloud`. Scopes
   `openid`, `email`, `profile`. While it is in **Testing**, only the test
   users you add can sign in; publish it to let anyone in.
2. **Credentials → Create credentials → OAuth client ID → Web application**.
   Add both callbacks above under **Authorised redirect URIs** (one client
   works for local and server).
3. Copy the client ID and secret.

## GitHub

GitHub allows one callback per OAuth app, so make two
(<https://github.com/settings/developers> → **New OAuth App**):

- `secure-cloud (local)`: homepage `http://localhost:3000`, callback the
  local one above;
- `secure-cloud`: homepage `https://<domain>`, callback the server one.

For each, **Generate a new client secret** and copy it with the client ID.

## Turning it on

Locally: put the values in `.env`, then `pnpm local:start` and unseal.

On the server: SSH in, add the values (the server GitHub app's) to the
secrets file, and restart only the gateway, so the secrets service stays
unsealed:

```sh
sudo nano /etc/secure-cloud-platform/secrets.env
cd /home/ubuntu/secure-cloud
dc() { sudo docker compose --project-directory deploy -f deploy/docker-compose.yml \
  --env-file deploy/.env --env-file /etc/secure-cloud-platform/secrets.env "$@"; }
dc up -d --no-deps gateway
```

Every later deploy reads the same file. Check with
`curl https://api.<domain>/dashboard/v1/auth/oauth/providers`: it lists the
providers that are on.

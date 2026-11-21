#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="${DATA_DIR:-/srv/secure-cloud-data}"
SECRETS_FILE=/etc/secure-cloud-platform/secrets.env
COMPOSE=(docker compose --project-directory "$APP_DIR" --file "$APP_DIR/docker-compose.yml"
  --env-file "$APP_DIR/.env" --env-file "$SECRETS_FILE")

fail() {
  echo "DEPLOY FAILED: $*" >&2
  exit 1
}

[[ "$(id -u)" == 0 ]] || fail "run it with sudo"
DOMAIN="${1:-${DOMAIN:-}}"
[[ "$DOMAIN" =~ ^[a-z0-9-]+(\.[a-z0-9-]+)+$ ]] || fail "usage: sudo deploy/deploy.sh <domain>, e.g. myname.duckdns.org"

random_hex() { od -An -tx1 -N32 /dev/urandom | tr -d ' \n'; }
install -d -m 0700 "$(dirname "$SECRETS_FILE")"
(
  umask 077
  touch "$SECRETS_FILE"
  for name in POSTGRES_PASSWORD GATEWAY_DB_PASSWORD SECRETS_DB_PASSWORD \
    STORAGE_DB_PASSWORD REDIS_PASSWORD API_KEY_HASH_SECRET \
    INTERNAL_SERVICE_TOKEN AUDIT_MIGRATOR_DB_PASSWORD AUDIT_DB_PASSWORD \
    AUDIT_HMAC_KEY AUDIT_TOKEN_GATEWAY AUDIT_TOKEN_SECRETS AUDIT_TOKEN_STORAGE \
    SESSION_SECRET FLAGS_DB_PASSWORD IDENTITY_DB_PASSWORD IDENTITY_SERVICE_TOKEN AUDIT_TOKEN_IDENTITY AUDIT_TOKEN_FLAGS; do
    if ! grep -q "^$name=" "$SECRETS_FILE"; then
      echo "Generating $name in $SECRETS_FILE."
      echo "$name=$(random_hex)" >>"$SECRETS_FILE"
    fi
  done
)
chmod 0600 "$SECRETS_FILE"

install -d -o 1000 -g 1000 -m 0750 "$DATA_DIR/files"
install -d -o 70 -g 70 -m 0700 "$DATA_DIR/postgres"
install -d -o 1001 -g 1001 -m 0700 "$DATA_DIR/caddy"

commit="$(git -C "$APP_DIR/.." rev-parse HEAD 2>/dev/null || echo unknown)"
cat >"$APP_DIR/.env" <<EOF
DATA_DIR=$DATA_DIR
SERVICE_VERSION=$commit
DASHBOARD_ORIGIN=https://$DOMAIN
DASHBOARD_API_ORIGIN=https://api.$DOMAIN
DASHBOARD_HOST=$DOMAIN
API_HOST=api.$DOMAIN
API_KEY_PREFIX=sk_live_
EOF

echo "Building and starting commit $commit for https://$DOMAIN ..."
if ! "${COMPOSE[@]}" up --build --detach --wait --wait-timeout 300 --remove-orphans; then
  "${COMPOSE[@]}" ps --all || true
  "${COMPOSE[@]}" logs --no-color --tail 100 || true
  fail "containers did not become healthy"
fi
"${COMPOSE[@]}" ps

seal_status="$("${COMPOSE[@]}" exec -T secrets secrets-operator status --json 2>/dev/null || true)"
if [[ "$seal_status" == *'"initialised":false'* ]]; then
  echo "NEXT: initialise the secrets service (docs/deploy-ec2.md, step 6)."
elif [[ "$seal_status" == *'"sealed":true'* ]]; then
  echo "NEXT: unseal the secrets service with 3 shares (docs/deploy-ec2.md, step 7)."
fi

docker image prune --force >/dev/null
echo "Done: https://$DOMAIN (dashboard) and https://api.$DOMAIN (API)."

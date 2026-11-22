#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="${DATA_DIR:-/srv/secure-cloud-data}"
GATEWAY_URL="${GATEWAY_URL:-http://127.0.0.1:8080}"
SECRETS_FILE=/etc/secure-cloud-platform/secrets.env
COMPOSE=(docker compose --project-directory "$APP_DIR" --file "$APP_DIR/docker-compose.yml"
  --env-file "$APP_DIR/.env" --env-file "$SECRETS_FILE")
UUID_PATTERN='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

umask 077
work_dir="$(mktemp -d)"
tenant_id=""
key_id=""
file_id=""
secret_saved=false
SECRET_URL="$GATEWAY_URL/v1/secrets/smoke-test"

cleanup() {
  if [[ "$secret_saved" == true && -f "$work_dir/key-header" ]]; then
    curl --silent --output /dev/null --max-time 5 -X DELETE -H "@$work_dir/key-header" "$SECRET_URL" || true
  fi
  if [[ "$file_id" =~ $UUID_PATTERN && -f "$work_dir/key-header" ]]; then
    curl --silent --output /dev/null --max-time 5 -X DELETE -H "@$work_dir/key-header" \
      "$GATEWAY_URL/v1/storage/files/$file_id" || true
  fi
  if [[ "$key_id" =~ $UUID_PATTERN ]]; then
    revoke_key >/dev/null 2>&1 || true
  fi
  rm -rf "$work_dir"
}
trap cleanup EXIT

fail() {
  echo "FAIL  $*" >&2
  echo "----- last 50 log lines per container -----"
  "${COMPOSE[@]}" logs --no-color --timestamps --tail 50 || true
  exit 1
}
pass() { echo "PASS  $*"; }

json_field() { sed -nE "s/.*\"$1\":\"([^\"]+)\".*/\\1/p" <<<"$2"; }

health="$(curl --fail --silent --show-error --max-time 5 "$GATEWAY_URL/health")" ||
  fail "gateway health endpoint did not answer"
[[ "$health" == *'"status":"ok"'* ]] || fail "gateway health returned: $health"
pass "gateway /health"

if grep -q 'DASHBOARD_IMAGE' "$APP_DIR/docker-compose.yml"; then
  headers="$(curl --fail --silent --show-error --max-time 10 --dump-header - --output /dev/null \
    "${DASHBOARD_URL:-http://127.0.0.1:3000}/login")" || fail "dashboard login page did not answer"
  grep -qi '^content-security-policy:' <<<"$headers" || fail "dashboard answered without a Content-Security-Policy"
  pass "dashboard /login (with a Content-Security-Policy)"
fi

if grep -q 'DASHBOARD_ORIGIN' "$APP_DIR/docker-compose.yml"; then
  origin="$(sed -n 's/^DASHBOARD_ORIGIN=//p' "$APP_DIR/.env")"
  [[ -n "$origin" ]] || fail "no DASHBOARD_ORIGIN in $APP_DIR/.env"
  dashboard() { # dashboard <method> <path> [json body]
    curl --fail --silent --show-error --max-time 15 -X "$1" -H "Origin: $origin" \
      -H "@$work_dir/session-header" -H "@$work_dir/csrf-header" \
      --dump-header "$work_dir/last-headers" \
      ${3:+-H "Content-Type: application/json" --data "$3"} "$GATEWAY_URL/dashboard/v1$2"
  }
  : >"$work_dir/session-header"
  : >"$work_dir/csrf-header"
  if [[ ! -s "$APP_DIR/smoke-account" ]]; then
    printf 'SMOKE_EMAIL=smoke-%s@smoke-test.invalid\nSMOKE_PASSWORD=%s\n' \
      "$(od -An -tx1 -N6 /dev/urandom | tr -d ' \n')" "$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n')" \
      >"$APP_DIR/smoke-account"
    chmod 0600 "$APP_DIR/smoke-account"
    signing_up=true
  else
    signing_up=false
  fi
  smoke_email="$(sed -n 's/^SMOKE_EMAIL=//p' "$APP_DIR/smoke-account")"
  smoke_password="$(sed -n 's/^SMOKE_PASSWORD=//p' "$APP_DIR/smoke-account")"
  printf '{"email":"%s","password":"%s","workspaceName":"smoke-test"}' "$smoke_email" "$smoke_password" \
    >"$work_dir/credentials.json"
  unset smoke_password
  if [[ "$signing_up" == true ]]; then
    me="$(dashboard POST /auth/sign-up "@$work_dir/credentials.json")" || fail "could not sign up the smoke-test account"
  else
    me="$(dashboard POST /auth/login "@$work_dir/credentials.json")" || fail "could not log in to the smoke-test account"
  fi
  rm -f "$work_dir/credentials.json"
  session="$(sed -nE 's/^[Ss]et-[Cc]ookie: ([^;]+);.*/\1/p' "$work_dir/last-headers" | head -n 1)"
  [[ -n "$session" ]] || fail "signing in set no session cookie"
  printf 'Cookie: %s\n' "$session" >"$work_dir/session-header"
  unset session
  csrf="$(json_field csrfToken "$(dashboard GET /auth/csrf)")" || fail "could not get a CSRF token"
  printf 'X-CSRF-Token: %s\n' "$csrf" >"$work_dir/csrf-header"
  unset csrf
  tenant_id="$(sed -nE 's/.*"workspaces":\[\{"id":"([^"]+)".*/\1/p' <<<"$me")"
  [[ "$tenant_id" =~ $UUID_PATTERN ]] || fail "signing in returned no workspace"
  pass "dashboard API: signed in to the smoke-test workspace $tenant_id"

  created="$(dashboard POST "/workspaces/$tenant_id/api-keys" '{"name":"smoke-test run"}')" ||
    fail "could not create an API key"
  key_id="$(sed -nE 's/.*"apiKey":\{"id":"([^"]+)".*/\1/p' <<<"$created")"
  revoke_key() { dashboard DELETE "/workspaces/$tenant_id/api-keys/$key_id"; }
  sign_out() { dashboard POST /auth/logout >/dev/null 2>&1 || true; }
else
  admin_token="$(sed -n 's/^ADMIN_TOKEN=//p' "$SECRETS_FILE")"
  [[ -n "$admin_token" ]] || fail "no ADMIN_TOKEN in $SECRETS_FILE"
  printf 'Authorization: Bearer %s\n' "$admin_token" >"$work_dir/admin-header"
  unset admin_token
  admin() { # admin <method> <path> [json body]
    curl --fail --silent --show-error --max-time 10 -X "$1" -H "@$work_dir/admin-header" \
      ${3:+-H "Content-Type: application/json" --data "$3"} "$GATEWAY_URL/admin$2"
  }
  tenant_id="$(cat "$APP_DIR/smoke-tenant-id" 2>/dev/null || true)"
  if [[ ! "$tenant_id" =~ $UUID_PATTERN ]] || ! admin GET "/tenants/$tenant_id/api-keys" >/dev/null 2>&1; then
    tenant_id="$(json_field id "$(admin POST /tenants '{"name":"smoke-test"}')")" ||
      fail "could not create the smoke-test tenant"
    [[ "$tenant_id" =~ $UUID_PATTERN ]] || fail "creating the smoke-test tenant returned no ID"
    echo "$tenant_id" >"$APP_DIR/smoke-tenant-id"
  fi
  pass "admin API (smoke-test tenant $tenant_id)"
  created="$(admin POST "/tenants/$tenant_id/api-keys" '{"name":"smoke-test run"}')" ||
    fail "could not create an API key"
  key_id="$(json_field id "$created")"
  revoke_key() { admin DELETE "/tenants/$tenant_id/api-keys/$key_id"; }
  sign_out() { :; }
fi
key="$(json_field key "$created")"
unset created
[[ "$key_id" =~ $UUID_PATTERN && -n "$key" ]] || fail "creating an API key returned no key"
printf 'Authorization: Bearer %s\n' "$key" >"$work_dir/key-header"
unset key
pass "API key created"

status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 \
  -X POST --data-binary "x" "$GATEWAY_URL/v1/storage/files")"
[[ "$status" == "401" ]] || fail "upload without a key returned HTTP $status, expected 401"
pass "requests without a key are refused (401)"

internal_services=(storage postgres redis)
seal_status=""
if "${COMPOSE[@]}" config --services 2>/dev/null | grep -qx secrets; then
  internal_services+=(secrets)
  seal_status="$("${COMPOSE[@]}" exec -T secrets secrets-operator status --json 2>/dev/null || true)"
  [[ "$seal_status" == *'"sealed":'* ]] || fail "could not read the secrets service's seal status"
fi
encrypted_storage=false
if "${COMPOSE[@]}" config --services 2>/dev/null | grep -qx storage-migrate; then
  encrypted_storage=true
fi

if [[ "$seal_status" == *'"sealed":true'* && "$encrypted_storage" == true ]]; then
  status="$(curl --silent --output "$work_dir/sealed-upload.json" --write-out '%{http_code}' --max-time 10 \
    -H "@$work_dir/key-header" -X POST "$GATEWAY_URL/v1/storage/files" \
    -H "Content-Type: application/octet-stream" --data-binary "x")"
  if [[ "$status" != "503" ]] || ! grep -q '"SECRETS_SEALED"' "$work_dir/sealed-upload.json"; then
    fail "an upload while sealed returned HTTP $status, expected 503 SECRETS_SEALED"
  fi
  pass "uploads are refused with 503 SECRETS_SEALED while the secrets service is sealed"
  curl --fail --silent --show-error --max-time 10 -H "@$work_dir/key-header" \
    -o /dev/null "$GATEWAY_URL/v1/storage/files" || fail "listing files while sealed failed"
  pass "listing files works while sealed"
else
  head -c 65536 /dev/urandom >"$work_dir/upload.bin"
  response="$(curl --fail --silent --show-error --max-time 30 -H "@$work_dir/key-header" \
    -X POST "$GATEWAY_URL/v1/storage/files" -H "Content-Type: application/octet-stream" \
    --data-binary "@$work_dir/upload.bin")" || fail "upload through the gateway failed"
  file_id="$(json_field id "$response")"
  [[ "$file_id" =~ $UUID_PATTERN ]] || fail "upload returned no valid file ID: $response"
  pass "upload ($file_id)"

  curl --fail --silent --show-error --max-time 30 -H "@$work_dir/key-header" \
    -o "$work_dir/download.bin" "$GATEWAY_URL/v1/storage/files/$file_id" ||
    fail "download through the gateway failed"
  [[ "$(sha256sum <"$work_dir/upload.bin")" == "$(sha256sum <"$work_dir/download.bin")" ]] ||
    fail "downloaded bytes differ from the uploaded bytes"
  pass "download matches upload"

  if [[ "$encrypted_storage" == true ]]; then
    status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 -X DELETE \
      -H "@$work_dir/key-header" "$GATEWAY_URL/v1/storage/files/$file_id")"
    [[ "$status" == "204" ]] || fail "deleting the test file returned HTTP $status"
  else
    rm -f "${DATA_DIR:?}/files/$tenant_id/$file_id"
  fi
  status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 \
    -H "@$work_dir/key-header" "$GATEWAY_URL/v1/storage/files/$file_id")"
  [[ "$status" == "404" ]] || fail "test file still served after deleting it (HTTP $status)"
  file_id=""
  pass "test file deleted"
fi

if [[ "$seal_status" == *'"sealed":true'* ]]; then
  curl --silent --output "$work_dir/sealed.json" --write-out '%{http_code}' --max-time 10 \
    -H "@$work_dir/key-header" "$SECRET_URL" >"$work_dir/sealed.status"
  if [[ "$(cat "$work_dir/sealed.status")" != "503" ]] || ! grep -q '"SECRETS_SEALED"' "$work_dir/sealed.json"; then
    fail "a sealed secrets service didn't answer 503 SECRETS_SEALED"
  fi
  pass "secrets service is sealed, and refuses secrets with 503 SECRETS_SEALED (as expected after a deployment)"
  echo "::warning::ACTION REQUIRED: unseal the secrets service with 3 shares (docs/runbook.md). Until then secrets, file uploads and file downloads get 503 SECRETS_SEALED; listing files keeps working."
elif [[ "$seal_status" == *'"sealed":false'* ]]; then
  secret_value="smoke-$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')"
  printf '{"value":"%s"}' "$secret_value" >"$work_dir/secret.json"
  status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 -X PUT \
    -H "@$work_dir/key-header" -H "Content-Type: application/json" \
    --data-binary "@$work_dir/secret.json" "$SECRET_URL")"
  [[ "$status" == "201" || "$status" == "200" ]] || fail "saving a secret returned HTTP $status"
  secret_saved=true
  curl --fail --silent --show-error --max-time 10 -H "@$work_dir/key-header" \
    --dump-header "$work_dir/secret.headers" -o "$work_dir/secret-read.json" "$SECRET_URL" ||
    fail "reading the secret back failed"
  grep -qF "\"value\":\"$secret_value\"" "$work_dir/secret-read.json" || fail "the secret read back is different"
  grep -qi '^cache-control: no-store' "$work_dir/secret.headers" || fail "the secret was returned without Cache-Control: no-store"
  status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 -X DELETE \
    -H "@$work_dir/key-header" "$SECRET_URL")"
  [[ "$status" == "204" ]] || fail "deleting the secret returned HTTP $status"
  secret_saved=false
  unset secret_value
  pass "secrets: save, read back (no-store) and delete"
fi

for service in "${internal_services[@]}"; do
  container="$("${COMPOSE[@]}" ps --quiet "$service")"
  [[ -n "$container" ]] || fail "$service container is not running"
  [[ -z "$(docker port "$container")" ]] ||
    fail "$service publishes ports on the host: $(docker port "$container")"
done
if curl --silent --max-time 3 "http://127.0.0.1:3001/health" >/dev/null; then
  fail "storage answered on the host at 127.0.0.1:3001"
fi
pass "${internal_services[*]} ports are not exposed on the host"

revoke_key >/dev/null || fail "could not revoke the test key"
status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 \
  -H "@$work_dir/key-header" "$GATEWAY_URL/v1/storage/files/00000000-0000-4000-8000-000000000000")"
[[ "$status" == "401" ]] || fail "revoked key still accepted (HTTP $status)"
key_id=""
pass "revoked key is refused (401)"
sign_out

echo "All smoke tests passed."

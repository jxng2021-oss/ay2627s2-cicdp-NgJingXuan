# 0015: Tamper-evident audit log and basic local monitoring

- Status: Accepted; the metrics and local monitoring parts removed by [0032](0032-simpler-project.md); the audit log stands
- Date: 2026-11-05

## Context

Nothing recorded who read a secret, created a key or downloaded a file, and
nothing showed whether the services were healthy. We want an audit log that
an attacker (or a mistake) can't quietly change, and enough monitoring to
see health, traffic, errors, latency, the seal state, storage and audit
failures. This is a prototype: no distributed tracing, log aggregation,
alert notifications, frontend or demo app.

## Decisions

### A separate audit service

`services/audit` (Fastify, internal network only, no published port) owns
its own `audit` database. Two logins (`deploy/postgres-setup.sql`):

- `audit_migrator` owns the database and runs the migrations;
- `audit_app`, used by the running service, has **INSERT and SELECT only**:
  it can't UPDATE, DELETE or TRUNCATE audit rows, or change the schema
  (tested end to end).

Other services send events to `POST /internal/events` with
`X-Audit-Service: <name>` and that service's **own** token
(`AUDIT_TOKEN_GATEWAY`, `_SECRETS`, `_STORAGE`; compared in constant time
via SHA-256 digests). An unknown service or wrong token gets 403, and a
service may only record **its own** actions (storage can't claim a secret
read). The gateway reads a tenant's events from `GET /events` for
`GET /v1/audit-events`.

### What an event holds

ID, time, tenant ID, the sending service, actor type (`api_key`, `admin`,
`operator`, `service`), actor ID (an API key's **ID**), action, resource
type, resource ID, outcome (`success`, `denied`, `failure`), request ID and
source IP.

- Actions come from a **fixed list** (`services/audit/src/actions.ts`);
  anything else is refused. The resource type and chain follow from the
  action, so the sender can't choose them.
- Every field is validated strictly (UUIDs, a strict resource-ID pattern,
  `net.isIP` for the address; no extra fields). The gateway builds events
  only from what it has verified: the tenant and key ID from the verified
  key, names that passed the route's schema, its own request ID and the
  connection's address. It passes the key ID and client IP to the internal
  services as `X-Actor-Id` and `X-Client-Ip`, replacing anything a client
  sent; they ignore malformed values.
- **Never** secret values, API keys, encryption keys, shares, file contents
  or request bodies (tested in every service).

Recorded: API key created/revoked; tenant created/suspended (a suspend
admin route was added for this); secret created/read/rotated/deleted
(including the proxy's internal read); proxy connection
created/updated/deleted/used; file uploaded/downloaded/deleted; secrets
service initialised/unsealed/sealed; and another tenant's attempt on an
existing file (`file.access_denied`, which still gets the same 404).

### The chain

Each tenant has its own chain, and the platform has one more (seal changes
and `file.access_denied`, so a file's owner never learns who tried, and the
caller learns nothing). Tenants can only ever read their own chain.

Each entry stores its position (`seq`: 1, 2, 3... per chain), the previous
entry's hash, and an HMAC-SHA-256, keyed with `AUDIT_HMAC_KEY`, over all its
fields and that previous hash. Changing any field changes the hash; removing,
inserting or reordering an entry breaks the sequence or the links; without
the key nobody can compute valid replacements.

Appending happens in one transaction that first takes a per-chain Postgres
advisory lock (`pg_advisory_xact_lock`), reads the chain's last entry and
inserts the next. Simultaneous events for one chain wait for each other; a
unique `(chain, seq)` constraint makes a fork impossible anyway. No
UPDATE is needed, so the service's login doesn't have it.

`node dist/verify.js <platform|tenant-id|--all>` (in the audit container)
re-checks chains and reports the **first** broken entry and why.

**Limits, stated plainly:** this detects changes; it does not prevent them.
Someone with full server access (the admin database login, or root and the
HMAC key) can rewrite or delete anything, and **deleting the newest entries
leaves no gap** that verification could notice. Anchoring the latest hashes
somewhere else (an append-only external store) would close that; it's left
for later.

### Which actions must be recorded first

| Action                                    | If the event can't be saved                                                                                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secret reads, creates, rotations, deletes | 503 `SERVICE_UNAVAILABLE`; a change is rolled back (the event is sent inside the database transaction, before the commit); a read's value is never returned |
| API key and tenant changes (admin)        | 503; rolled back the same way                                                                                                                               |
| Initialise, unseal, seal                  | 503 `AUDIT_UNAVAILABLE` from the operator command; nothing changes                                                                                          |
| Files, proxy connections and proxy use    | The action goes ahead. Two quick retries (200 ms, 800 ms), then a warning `AUDIT EVENT LOST` and `audit_events_failed_total` +1                             |

Trade-offs:

- **Availability:** while the audit service is down, secrets can't be read
  and keys can't change. We accept that: these actions must never happen
  unrecorded. Files and proxy calls are the bulk of the traffic and would
  stop the whole platform; for them a logged, counted (and alerted) gap is
  the better choice.
- **Seal:** refusing to seal without the audit log means the operator
  command can't be used as an emergency brake then. Stopping the secrets
  container always seals (the key only lives in its memory), and shutdown
  seals without recording, so an emergency stop is never blocked.
- **Rare false positives:** a change's event is saved just before its
  commit. If the commit itself then fails, the log shows an action that
  didn't take effect. The reverse (an action without an event) can't
  happen, which is the property we need.

### Metrics

Every service exposes Prometheus metrics with `prom-client`: request count,
5xx count and response time (by method, **route pattern** and status), plus
`audit_events_failed_total`, `secrets_sealed`, `storage_used_bytes` and the
storage volume's size and free space. Labels never contain tenant IDs, keys,
file names or raw URLs (tested). `/metrics` is only on the internal network:
storage, secrets and audit serve it on their own (internal) port; the
gateway serves it on a separate, unpublished port (9464), never on the
public one (tested through the gateway).

Every service also writes one JSON log line per request with its service,
version, request ID, route, status and duration, and the same request ID is
in the request's audit event.

### Local Prometheus and Grafana only

**Prototype decision:** Prometheus and Grafana are in the root
`docker-compose.yml` only, not `deploy/docker-compose.yml`; both are
published on 127.0.0.1 only. Grafana's admin password has no default
(`GRAFANA_ADMIN_PASSWORD`; Grafana refuses to start without it). Its data
source and dashboard are provisioned from `monitoring/grafana/`, Prometheus's
configuration and six alert rules from `monitoring/prometheus/`. The rules
are tested with `promtool test rules` in CI (pinned image, `pnpm
monitoring:check`). Alerts are shown in Prometheus and Grafana; there is no
Alertmanager, so nothing is sent.

## Left out

Distributed tracing, log aggregation, alert notifications (Alertmanager),
monitoring on the deployed servers, anchoring chain heads externally, audit
log retention and export, and a way to read the platform chain other than
the database and the verify command.

## Consequences

- One more service and database to run, back up and deploy (ECR repository,
  workflows, deploy script). Back up the audit database with the others.
- `AUDIT_HMAC_KEY` must never be lost or changed: every existing chain would
  fail verification.
- The audit service is on the path of every sensitive action; its
  availability matters as much as the secrets service's.

## Later change

See [0032](0032-simpler-project.md): Terraform, the AWS workflows, the monitoring stack and `/metrics` were removed; the server is set up by hand.

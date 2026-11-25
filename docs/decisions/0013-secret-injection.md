# 0013: Secret injection through a proxy route

- Status: Accepted
- Date: 2026-11-05

## Context

Tenants store keys for outside APIs (payment providers, mail services...)
in the secrets service. To use one, their app had to read it back and hold
it. We want the gateway to call the outside API on the tenant's behalf and
add the key itself, so the key never reaches the client at all. Making the
gateway send requests to addresses that tenants choose is exactly what
server-side request forgery (SSRF) attacks abuse, so the protections matter
as much as the feature. This is a prototype: no OAuth, caching, retries or
per-connection limits.

## Decisions

### Connections

`PUT /v1/proxy-connections/{name}` saves, per tenant, in the gateway's
database (`proxy_connections`):

- the base URL;
- the **name** of the secret (never its value);
- the header name;
- an optional prefix (e.g. `"Bearer "`).

Tenants only ever see and use their own connections; another tenant's is a 404. Header names the proxy manages itself (`Host`, `Content-Length`,
`Cookie`, `X-Tenant-Id`, `Proxy-*`...) are refused, and prefixes may only
hold printable ASCII, so nothing can inject extra headers.

### The proxy route

`ANY /v1/proxy/{connection}/{path}` uses the normal API key check and rate
limits. For every request:

1. Find the tenant's connection.
2. Check the target (SSRF rules below).
3. Fetch the secret's **latest** value from the secrets service over an
   internal-only route, `GET /internal/secrets/{name}`. It is fetched for
   every request and never cached in the gateway, so rotation takes effect
   at once and nothing lingers. If the secrets service is sealed, the
   answer is `503 SECRETS_SEALED` and nothing is sent. If the secret is
   missing, `409 PROXY_SECRET_MISSING`.
4. Forward the request, with these headers removed:
   - the client's `Authorization` (its own API key), `Cookie` and
     `X-Tenant-Id`;
   - any header with the connection's header name, so a client can't
     replace the secret;
   - hop-by-hop headers, including those named in `Connection`.

   Then add the secret in its header. Bodies are streamed, within the
   existing size limit and timeouts.

5. Return the answer without hop-by-hop headers and `Set-Cookie`. The
   outside API's own statuses and bodies pass through.
6. **Never follow redirects.** Following one would carry the secret to
   wherever the redirect points. A redirect becomes `502 UPSTREAM_REDIRECT`.
   Connection failures are `502 UPSTREAM_UNAVAILABLE`, slow answers
   `504 UPSTREAM_TIMEOUT`.

The secret is never logged, never put in an error and never added to a
response. **We can't stop the outside service from echoing it in its own
response** (some APIs repeat request headers in error messages); that
response reaches the client unchanged. JavaScript strings can't be erased
from memory either; the value is only held for the request.

### SSRF protections

| Rule                                                                                                                                                                                                             | Why                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `https://` only; no username, password, query or fragment in the base URL                                                                                                                                        | No plain-text keys; no credentials smuggled in the URL                                        |
| The host must be on `PROXY_ALLOWED_HOSTS` (exact names, empty by default)                                                                                                                                        | Operators decide which outside APIs exist; nothing else is reachable                          |
| Private, loopback and carrier-grade NAT addresses are blocked (IPv4 and IPv6)                                                                                                                                    | The internal network (Postgres, Redis, secrets...) stays out of reach                         |
| Link-local, cloud metadata (169.254.169.254, fd00:ec2::254, 100.100.100.200), reserved and multicast addresses are **always** blocked, whatever the settings                                                     | The metadata endpoint hands out cloud credentials                                             |
| IPv4 hidden in IPv6 (`::ffff:127.0.0.1`, NAT64, 6to4) is judged as the IPv4 address                                                                                                                              | Alternative spellings can't slip past                                                         |
| Numeric forms (`2130706433`, `0x7f.1`, `127.1`, octal, percent-encoded) are normalised by the URL parser before checking                                                                                         | Same                                                                                          |
| On every request the host is resolved, **every** returned address is checked, and the gateway connects to the address it checked (a pinned DNS lookup; TLS still verifies the certificate against the host name) | DNS rebinding: an answer that changes between check and connection can't redirect the request |
| The client's path is joined below the base path; `..`, `.`, encoded `/` `\\` `.`, backslashes and control characters are refused, and the result must keep the base URL's origin and path prefix                 | The path can't change the host or climb to another part of the outside API                    |
| Saved connections are re-checked on every request                                                                                                                                                                | Removing a host from the allowlist takes effect at once                                       |

`PROXY_ALLOW_PRIVATE_TARGETS=true` also allows `http://` and private or
loopback addresses, **only** for the local pretend outside API
(`tools/mock-upstream`, on the internal Docker network). The gateway
refuses to start with it when `NODE_ENV=production`, which is set in its
image. Link-local and metadata addresses stay blocked even then. The mock
exists only in the local `docker-compose.yml`, never in the deployment
files (checked by `pnpm test:stack`).

### The internal secret route

`GET /internal/secrets/{name}` exists only on the secrets service (internal
network). The gateway has no route that maps to it: the public secrets
routes forward to fixed internal paths built from validated names, and
connections can't target internal hosts. Tests check it can't be reached
through the gateway, and it is part of the internal contract
(`api/internal/secrets.openapi.json`), tested from both sides.

## Consequences

- Clients never handle outside API keys; rotating one in the secrets
  service changes every later proxied request.
- Each proxied request costs a secrets lookup and a DNS lookup, and opens
  its own connection to the checked address (no pooling across requests).
  That's simple and safe, at some latency cost.
- Operators must list allowed hosts in `PROXY_ALLOWED_HOSTS`. Until they do,
  the proxy refuses everything on a server.
- An outside API that echoes request headers can still expose its key to the
  caller. Document such APIs; we can't filter arbitrary response bodies.
- Not built: OAuth flows, caching, retries, per-connection rate limits.

# 0031: HTTPS on the servers with Caddy and an Elastic IP

- Status: Accepted; one server only since [0032](0032-simpler-project.md), deployed automatically since [0035](0035-automatic-deployment-ecr-ssm.md)
- Date: 2026-11-17

## Context

The deployed dashboard couldn't sign anyone in: its session cookie is
`Secure`, so it needs HTTPS, and the dashboard and gateway were reached
by IP on ports 3000 and 8080, open only to the owner's IP
(`allowed_cidr`). A domain with HTTPS had been left for the load balancer
phase. The owner asked to deploy now, on a free DuckDNS name, with Caddy
and a fixed (Elastic) IP, on one `t3.small` staging instance.

## Decision

- **Caddy** (`deploy/Caddyfile`, image pinned by digest) is the only
  container published to the internet, on 80 and 443. It serves two host
  names taken from the existing settings: the dashboard at the host of
  `DASHBOARD_ORIGIN` (e.g. `myname.duckdns.org`) and the gateway at the
  host of `DASHBOARD_API_ORIGIN` (`api.myname.duckdns.org`). DuckDNS
  points every subdomain at the same IP, and both names are the same
  site, so the session cookies work exactly as designed (ADR 0016, 0024).
- Caddy gets and renews **Let's Encrypt** certificates itself and keeps
  them on the data disk. Port 80 only answers certificate checks and
  redirects to HTTPS.
- The **security group** opens only 80 and 443, to everyone: it is a
  public website, and Let's Encrypt checks domains from unpublished
  addresses. `allowed_cidr` and the 8080/3000 rules are removed; those
  ports are published on the server's loopback only (the smoke test uses
  them).
- The gateway **trusts X-Forwarded-For only from Caddy's fixed address**
  (172.30.0.10 on a fixed public Docker network), so rate limits and
  audit events see the real client IP and nobody else can fake it.
- Caddy runs as an unprivileged user, read-only, with every capability
  dropped except `NET_BIND_SERVICE` (its binary carries that file
  capability, and the kernel refuses to run it without it).
- An **Elastic IP** gives the DNS a fixed address that survives stopping
  or replacing the instance. The default instance size becomes `t3.small`
  (2 GB), as nine containers don't fit in 1 GB.
- Fixed with this: the environments' Terraform only looked up three of the
  seven ECR repositories, so the deploy role couldn't push, and the
  instance couldn't pull, the audit, identity, flags and dashboard images.

## Consequences

- The dashboard and API are reachable by anyone on the internet; the
  platform's own authentication (API keys, sessions, rate limits) is what
  protects them, as it would behind a load balancer.
- One server terminates TLS. A load balancer, several nodes and
  certificates from AWS remain later-phase work; Caddy can then be
  removed or kept behind it.
- A DuckDNS name is free but belongs to the owner's DuckDNS account; a
  real domain only needs the two repository variables changed.
- If the DNS isn't set, Caddy keeps retrying; the rest of the stack works.

## Later change

See [0032](0032-simpler-project.md): Terraform, the AWS workflows, the monitoring stack and `/metrics` were removed; the server is set up by hand.

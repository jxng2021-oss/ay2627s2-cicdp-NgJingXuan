# 0023: Workspace analytics from the audit log

- Status: Accepted
- Date: 2026-11-15

## Context

The workspace overview showed counts (secrets, files, storage) but nothing
about what happens in the workspace over time: how many calls apps make
through connections, how many are refused by a policy, how often files
move, how often things change. Every one of those is already an event in
the workspace's tamper-evident audit chain ([0015](0015-audit-and-monitoring.md)).

## Decision

- **Source: the audit chain, nothing new to record.** The overview's
  "Activity" section is built only from the workspace's own audit events,
  so analytics can't disagree with the audit log and nothing extra is
  collected about people.
- **Counted by the audit service.** A new internal route,
  `GET /events/summary?from&to` (gateway only, the verified tenant's chain
  only, at most 200 days), answers counts per UTC day, action and outcome,
  and calls per connection, using the existing chain/time index. It never
  returns an event's details (IDs, request IDs, IPs, hashes). It is in
  `api/internal/audit.openapi.json` with contract tests on both sides.
- **Shaped by the gateway.** `GET /dashboard/v1/workspaces/:id/analytics?range=7d|30d|90d`
  (owners and members: members can read the audit log too) asks for this
  period and the one before, sorts actions into a few totals (calls
  succeeded / refused / failed, files uploaded / downloaded, changes,
  sign-ins / failed sign-ins), fills empty days with zeros and lists the five
  busiest connections. Reads (`secret.read`) are not counted as activity.
  If the audit service is down it answers 502; the rest of the overview
  still works.
- **Charts without a library.** `components/charts.tsx` draws them as SVG
  and HTML (no new dependency, nothing loaded from elsewhere, the CSP stays
  strict), following the dataviz method: thin columns with 4px rounded
  ends and 2px gaps, one axis, text in text colours, a legend for 2+
  series, a hover and keyboard (arrow keys) readout, and every chart's
  numbers in a table view. The series colours are tokens (`--viz-*`) chosen
  (succeeded, refused and failed in status green, amber and red) checked with the dataviz validator for
  colour-blind separation, lightness and contrast, in light and dark.
- **One range control** (7 / 30 / 90 days) above all of it; the stat tiles
  show the change from the previous period in words and an arrow, never
  colour alone. While a new range loads, the old charts stay, dimmed.

## Consequences

- Days are UTC days, like connection policies' daily limits
  ([0019](0019-connection-policies.md)); the overview says so.
- File and proxy events are best effort, so in a rare audit outage the
  charts can undercount those, exactly like the audit log itself.
- Not built: per-user breakdowns, exports, custom date ranges and alerts
  (alert notifications are a later phase).

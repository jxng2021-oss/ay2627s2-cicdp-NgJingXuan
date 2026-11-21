"use client";

import { useState } from "react";
import {
  BarList,
  StackedColumns,
  StatTile,
  type Series,
} from "@/components/charts";
import { EmptyState, ErrorState, Loading } from "@/components/ui";
import type { Analytics, AnalyticsRange } from "@/lib/api/client";
import { workspace as api } from "@/lib/api/endpoints";
import { useLoad } from "@/lib/use-load";

const RANGES: { value: AnalyticsRange; label: string; days: number }[] = [
  { value: "7d", label: "7 days", days: 7 },
  { value: "30d", label: "30 days", days: 30 },
  { value: "90d", label: "90 days", days: 90 },
];

const CALLS: Series[] = [
  { key: "succeeded", label: "Succeeded", color: "var(--viz-succeeded)" },
  { key: "refused", label: "Refused", color: "var(--viz-refused)" },
  { key: "failed", label: "Failed", color: "var(--viz-failed)" },
];
const ACTIVITY: Series[] = [
  { key: "count", label: "Events", color: "var(--viz-activity)" },
];

const short = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const long = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const asDate = (day: string) => new Date(`${day}T00:00:00Z`);

export function WorkspaceAnalytics({ workspaceId }: { workspaceId: string }) {
  const [range, setRange] = useState<AnalyticsRange>("7d");
  const load = useLoad(
    () => api.analytics(workspaceId, range),
    [workspaceId, range],
  );
  const days = RANGES.find((r) => r.value === range)!.days;

  return (
    <section className="analytics" aria-labelledby="activity-title">
      <div className="analytics-head">
        <div className="stack-2">
          <h2 id="activity-title">Activity</h2>
          <p className="muted">
            From this workspace&apos;s audit log, by UTC day.
          </p>
        </div>
        <div className="segmented" role="group" aria-label="Time range">
          {RANGES.map((r) => (
            <button
              key={r.value}
              type="button"
              aria-pressed={range === r.value}
              onClick={() => setRange(r.value)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
      {load.status === "loading" ? (
        <Loading label="Loading activity..." />
      ) : load.status === "error" ? (
        <ErrorState error={load.error} onRetry={load.reload} />
      ) : (
        <div
          className="analytics-body"
          data-stale={load.data.range !== range}
          aria-busy={load.data.range !== range}
        >
          <Charts data={load.data} days={days} />
        </div>
      )}
    </section>
  );
}

function Charts({ data, days }: { data: Analytics; days: number }) {
  const { totals, previous, daily } = data;
  const period = `the previous ${days} days`;
  const calls = (t: Analytics["totals"]) => t.succeeded + t.refused + t.failed;
  const files = (t: Analytics["totals"]) => t.filesUploaded + t.filesDownloaded;
  const anything =
    calls(totals) +
      files(totals) +
      totals.changes +
      totals.signIns +
      totals.failedSignIns >
    0;

  return (
    <>
      <div className="stats">
        <StatTile
          label="Calls through connections"
          value={calls(totals)}
          previous={calls(previous)}
          trend={daily.map(calls)}
          period={period}
        />
        <StatTile
          label="Refused calls"
          value={totals.refused}
          previous={previous.refused}
          trend={daily.map((d) => d.refused)}
          period={period}
          upIsGood={false}
        />
        <StatTile
          label="Files moved"
          value={files(totals)}
          previous={files(previous)}
          trend={daily.map(files)}
          period={period}
        />
        <StatTile
          label="Changes"
          value={totals.changes}
          previous={previous.changes}
          trend={daily.map((d) => d.changes)}
          period={period}
        />
      </div>

      {!anything ? (
        <EmptyState>
          Nothing has happened in the last {days} days. Calls through
          connections, file uploads and downloads, changes and sign ins will
          show here.
        </EmptyState>
      ) : (
        <div className="analytics-grid">
          <section
            className="card chart-card wide"
            aria-labelledby="calls-title"
          >
            <h3 id="calls-title">Calls per day</h3>
            <p className="muted">
              Calls apps made through this workspace&apos;s connections. Refused
              calls were stopped before the secret was read.
            </p>
            <StackedColumns
              title="Calls per day"
              series={CALLS}
              columns={daily.map((d) => ({
                label: short.format(asDate(d.day)),
                fullLabel: long.format(asDate(d.day)),
                values: {
                  succeeded: d.succeeded,
                  refused: d.refused,
                  failed: d.failed,
                },
              }))}
            />
          </section>

          <section className="card chart-card" aria-labelledby="busiest-title">
            <h3 id="busiest-title">Busiest connections</h3>
            {data.connections.length === 0 ? (
              <p className="muted">No calls through connections yet.</p>
            ) : (
              <BarList
                title="Calls per connection"
                series={CALLS}
                items={data.connections.map((c) => ({
                  label: c.name,
                  values: {
                    succeeded: c.succeeded,
                    refused: c.refused,
                    failed: c.failed,
                  },
                }))}
              />
            )}
          </section>

          <section className="card chart-card" aria-labelledby="types-title">
            <h3 id="types-title">Activity by type</h3>
            <BarList
              title="Events by type"
              series={ACTIVITY}
              items={[
                {
                  label: "Files uploaded",
                  values: { count: totals.filesUploaded },
                },
                {
                  label: "Files downloaded",
                  values: { count: totals.filesDownloaded },
                },
                { label: "Changes", values: { count: totals.changes } },
                { label: "Sign ins", values: { count: totals.signIns } },
                {
                  label: "Failed sign ins",
                  values: { count: totals.failedSignIns },
                },
              ]}
            />
          </section>
        </div>
      )}
    </>
  );
}

import type { FastifyReply, FastifyRequest } from "fastify";
import { sendError } from "../../errors.js";
import { fetchJson, type Upstream } from "../../services/upstream.service.js";

export const RANGES = { "7d": 7, "30d": 30, "90d": 90 } as const;
export type Range = keyof typeof RANGES;

const DAY_MS = 24 * 60 * 60 * 1000;
const TOP_CONNECTIONS = 5;

export interface Summary {
  daily: { day: string; action: string; outcome: string; count: number }[];
  connections: {
    resourceId: string;
    action: string;
    outcome: string;
    count: number;
  }[];
}

export interface Totals {
  succeeded: number;
  refused: number;
  failed: number;
  filesUploaded: number;
  filesDownloaded: number;
  changes: number;
  signIns: number;
  failedSignIns: number;
}

const CHANGES = new Set([
  "secret.created",
  "secret.rotated",
  "secret.deleted",
  "api_key.created",
  "api_key.revoked",
  "api_key.deleted",
  "proxy_connection.created",
  "proxy_connection.updated",
  "proxy_connection.deleted",
  "file.deleted",
]);

const emptyTotals = (): Totals => ({
  succeeded: 0,
  refused: 0,
  failed: 0,
  filesUploaded: 0,
  filesDownloaded: 0,
  changes: 0,
  signIns: 0,
  failedSignIns: 0,
});

function add(totals: Totals, action: string, outcome: string, count: number) {
  if (action === "proxy_connection.used") {
    if (outcome === "success") totals.succeeded += count;
    else if (outcome === "denied") totals.refused += count;
    else totals.failed += count;
  } else if (action === "proxy_connection.denied") {
    totals.refused += count;
  } else if (action === "user.login_failed") {
    totals.failedSignIns += count;
  } else if (outcome === "success") {
    addSuccess(totals, action, count);
  }
}

function addSuccess(totals: Totals, action: string, count: number) {
  if (action === "file.uploaded") {
    totals.filesUploaded += count;
  } else if (action === "file.downloaded") {
    totals.filesDownloaded += count;
  } else if (action === "user.logged_in") {
    totals.signIns += count;
  } else if (CHANGES.has(action)) {
    totals.changes += count;
  }
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function rangeStart(range: Range, now: Date): number {
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  return today - (RANGES[range] - 1) * DAY_MS;
}

function busiest(connections: Summary["connections"]) {
  const byName = new Map<
    string,
    { name: string; succeeded: number; refused: number; failed: number }
  >();
  for (const row of connections) {
    const entry = byName.get(row.resourceId) ?? {
      name: row.resourceId,
      succeeded: 0,
      refused: 0,
      failed: 0,
    };
    if (row.action === "proxy_connection.denied" || row.outcome === "denied") {
      entry.refused += row.count;
    } else if (row.outcome === "success") {
      entry.succeeded += row.count;
    } else {
      entry.failed += row.count;
    }
    byName.set(row.resourceId, entry);
  }
  const calls = (c: { succeeded: number; refused: number; failed: number }) =>
    c.succeeded + c.refused + c.failed;
  return [...byName.values()]
    .sort((a, b) => calls(b) - calls(a) || a.name.localeCompare(b.name))
    .slice(0, TOP_CONNECTIONS);
}

export function buildAnalytics(
  current: Summary,
  before: Summary,
  range: Range,
  now: Date,
) {
  const first = rangeStart(range, now);
  const daily = new Map<string, Totals>();
  for (let i = 0; i < RANGES[range]; i++) {
    daily.set(isoDay(first + i * DAY_MS), emptyTotals());
  }
  const totals = emptyTotals();
  for (const row of current.daily) {
    const day = daily.get(row.day);
    if (!day) continue;
    add(day, row.action, row.outcome, row.count);
    add(totals, row.action, row.outcome, row.count);
  }
  const previous = emptyTotals();
  for (const row of before.daily) {
    add(previous, row.action, row.outcome, row.count);
  }
  return {
    range,
    firstDay: isoDay(first),
    lastDay: isoDay(first + (RANGES[range] - 1) * DAY_MS),
    daily: [...daily].map(([day, counts]) => ({ day, ...counts })),
    totals,
    previous,
    connections: busiest(current.connections),
  };
}

export function analyticsController(
  auditService: Upstream,
  auditToken: string,
) {
  const headers = {
    authorization: `Bearer ${auditToken}`,
    "x-audit-service": "gateway",
  };
  const summary = (request: FastifyRequest, from: number, to: number) =>
    fetchJson(
      auditService,
      request,
      `/events/summary?from=${new Date(from).toISOString()}&to=${new Date(to).toISOString()}`,
      headers,
    );

  return async (request: FastifyRequest, reply: FastifyReply) => {
    const { range = "7d" } = request.query as { range?: Range };
    const now = new Date();
    const first = rangeStart(range, now);
    const length = RANGES[range] * DAY_MS;
    const [current, before] = await Promise.all([
      summary(request, first, now.getTime() + 1),
      summary(request, first - length, first),
    ]);
    if (current.status !== 200 || before.status !== 200) {
      return sendError(
        reply,
        502,
        "UPSTREAM_UNAVAILABLE",
        "Audit service is unavailable",
      );
    }
    return buildAnalytics(
      current.body as Summary,
      before.body as Summary,
      range,
      now,
    );
  };
}

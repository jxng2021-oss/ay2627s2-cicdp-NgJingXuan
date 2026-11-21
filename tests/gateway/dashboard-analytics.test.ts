import { describe, expect, it } from "vitest";
import {
  buildAnalytics,
  rangeStart,
  type Summary,
} from "../../services/gateway/src/controllers/dashboard/analytics.controller.js";
import { Browser, fakeAuditEvents } from "./dashboard-helpers.js";
import {
  createTestDatabase,
  expectError,
  FakeAudit,
  startFakeStorage,
  startGateway,
} from "./helpers.js";

const NOW = new Date("2026-11-15T10:30:00Z");
const none: Summary = { daily: [], connections: [] };

describe("buildAnalytics", () => {
  it("has one entry per day of the range, oldest first, zeros included", () => {
    const result = buildAnalytics(none, none, "7d", NOW);
    expect(result.firstDay).toBe("2026-11-09");
    expect(result.lastDay).toBe("2026-11-15");
    expect(result.daily.map((d) => d.day)).toEqual([
      "2026-11-09",
      "2026-11-10",
      "2026-11-11",
      "2026-11-12",
      "2026-11-13",
      "2026-11-14",
      "2026-11-15",
    ]);
    expect(result.daily.every((d) => d.succeeded === 0)).toBe(true);
    expect(buildAnalytics(none, none, "90d", NOW).daily).toHaveLength(90);
    expect(new Date(rangeStart("30d", NOW)).toISOString()).toBe(
      "2026-10-17T00:00:00.000Z",
    );
  });

  it("sorts each action and outcome into its total", () => {
    const day = "2026-11-14";
    const current: Summary = {
      daily: [
        { day, action: "proxy_connection.used", outcome: "success", count: 9 },
        { day, action: "proxy_connection.used", outcome: "denied", count: 1 },
        { day, action: "proxy_connection.used", outcome: "failure", count: 2 },
        { day, action: "proxy_connection.denied", outcome: "denied", count: 3 },
        { day, action: "file.uploaded", outcome: "success", count: 4 },
        { day, action: "file.downloaded", outcome: "success", count: 5 },
        { day, action: "secret.rotated", outcome: "success", count: 1 },
        { day, action: "api_key.created", outcome: "success", count: 1 },
        { day, action: "user.logged_in", outcome: "success", count: 2 },
        { day, action: "user.login_failed", outcome: "denied", count: 6 },
        { day, action: "secret.read", outcome: "success", count: 50 },
        { day, action: "api_key.created", outcome: "failure", count: 7 },
        {
          day: "2026-11-01",
          action: "file.uploaded",
          outcome: "success",
          count: 99,
        },
      ],
      connections: [],
    };
    const before: Summary = {
      daily: [
        {
          day: "2026-11-05",
          action: "proxy_connection.used",
          outcome: "success",
          count: 4,
        },
      ],
      connections: [],
    };
    const result = buildAnalytics(current, before, "7d", NOW);
    const expected = {
      succeeded: 9,
      refused: 4,
      failed: 2,
      filesUploaded: 4,
      filesDownloaded: 5,
      changes: 2,
      signIns: 2,
      failedSignIns: 6,
    };
    expect(result.totals).toEqual(expected);
    expect(result.daily.find((d) => d.day === day)).toEqual({
      day,
      ...expected,
    });
    expect(result.previous.succeeded).toBe(4);
  });

  it("lists the busiest connections, at most five", () => {
    const connections: Summary["connections"] = [];
    for (const [name, calls] of [
      ["a", 1],
      ["b", 6],
      ["c", 3],
      ["d", 2],
      ["e", 5],
      ["f", 4],
    ] as const) {
      connections.push({
        resourceId: name,
        action: "proxy_connection.used",
        outcome: "success",
        count: calls,
      });
    }
    connections.push({
      resourceId: "a",
      action: "proxy_connection.denied",
      outcome: "denied",
      count: 10,
    });
    const result = buildAnalytics({ daily: [], connections }, none, "7d", NOW);
    expect(result.connections.map((c) => c.name)).toEqual([
      "a",
      "b",
      "e",
      "f",
      "c",
    ]);
    expect(result.connections[0]).toEqual({
      name: "a",
      succeeded: 1,
      refused: 10,
      failed: 0,
    });
  });
});

describe("GET /dashboard/v1/workspaces/:id/analytics", () => {
  it("asks the audit service for this period and the one before, for the member's workspace only", async () => {
    const { db } = await createTestDatabase();
    const auditService = await fakeAuditEvents((url) => {
      const from = new URL(url, "http://audit").searchParams.get("from")!;
      const day = from.slice(0, 10);
      return {
        daily: [
          {
            day,
            action: "proxy_connection.used",
            outcome: "success",
            count: 3,
          },
        ],
        connections: [
          {
            resourceId: "payments",
            action: "proxy_connection.used",
            outcome: "success",
            count: 3,
          },
        ],
      };
    });
    const app = await startGateway({
      db,
      audit: new FakeAudit(),
      auditUrl: auditService.url,
    });
    const owner = new Browser(app);
    const workspace = await owner.signUp("owner@example.com", "Analytics");

    const response = await owner.request(
      "GET",
      owner.ws(workspace, "/analytics?range=30d"),
    );
    expect(response.statusCode).toBe(200);
    const body = response.json<ReturnType<typeof buildAnalytics>>();
    expect(body.range).toBe("30d");
    expect(body.daily).toHaveLength(30);
    expect(body.totals.succeeded).toBe(3);
    expect(body.previous.succeeded).toBe(3);
    expect(body.connections).toEqual([
      { name: "payments", succeeded: 3, refused: 0, failed: 0 },
    ]);

    const asked = auditService.requests.filter((r) =>
      r.url.startsWith("/events/summary"),
    );
    expect(asked).toHaveLength(2);
    expect(asked.every((r) => r.headers["x-tenant-id"] === workspace)).toBe(
      true,
    );
    expect(auditService.problems).toEqual([]);

    expectError(
      await owner.request("GET", owner.ws(workspace, "/analytics?range=1y")),
      400,
      "BAD_REQUEST",
    );
  });

  it("answers 502 when the audit service can't be reached", async () => {
    const { db } = await createTestDatabase();
    const broken = await startFakeStorage((_req, res) => {
      res.destroy();
    });
    const app = await startGateway({
      db,
      audit: new FakeAudit(),
      auditUrl: broken,
    });
    const owner = new Browser(app);
    const workspace = await owner.signUp("owner@example.com", "Analytics");
    expectError(
      await owner.request("GET", owner.ws(workspace, "/analytics")),
      502,
      "UPSTREAM_UNAVAILABLE",
    );
  });
});

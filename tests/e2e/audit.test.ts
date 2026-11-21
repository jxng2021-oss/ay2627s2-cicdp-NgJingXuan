import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  admin,
  createTenantWithKey,
  download,
  expectError,
  freshWindow,
  GATEWAY_URL,
  psql,
  secrets,
  sleep,
  upload,
} from "./helpers.js";
import { dockerCompose } from "./operator.js";

interface AuditEvent {
  action: string;
  outcome: string;
  actorType: string;
  actorId: string | null;
  resourceId: string | null;
  requestId: string | null;
  sourceIp: string | null;
}

function auditEvents(key: string, query = "") {
  return fetch(`${GATEWAY_URL}/v1/audit-events${query}`, {
    headers: { authorization: `Bearer ${key}` },
  });
}

async function eventFor(key: string, requestId: string): Promise<AuditEvent> {
  for (let i = 0; i < 40; i++) {
    const body = (await (await auditEvents(key)).json()) as {
      events: AuditEvent[];
    };
    const found = body.events.find((e) => e.requestId === requestId);
    if (found) return found;
    await sleep(250);
  }
  throw new Error(`no audit event for request ${requestId}`);
}

async function verify(chain: string) {
  const result = await dockerCompose([
    "exec",
    "-T",
    "audit",
    "node",
    "dist/verify.js",
    chain,
  ]);
  return { code: result.code, output: result.stdout + result.stderr };
}

async function waitForAudit(): Promise<void> {
  for (let i = 0; i < 120; i++) {
    const result = await dockerCompose([
      "exec",
      "-T",
      "audit",
      "wget",
      "-qO-",
      "http://127.0.0.1:3003/health",
    ]);
    if (result.code === 0) return;
    await sleep(500);
  }
  throw new Error("the audit service didn't come back");
}

beforeAll(freshWindow);

describe("audit events", () => {
  it("a secret rotation and a file upload can be found by their request ID", async () => {
    const { key, keyId } = await createTenantWithKey("e2e-audit");
    await secrets(key, "PUT", "/db-password", "e2e-secret-value-audit");

    const read = await secrets(
      key,
      "POST",
      "/db-password/rotate",
      "e2e-secret-value-audit-2",
    );
    const uploaded = await upload(key, randomBytes(1024));

    expect([read.status, uploaded.status]).toEqual([200, 201]);
    const readEvent = await eventFor(key, read.headers.get("x-request-id")!);
    const uploadEvent = await eventFor(
      key,
      uploaded.headers.get("x-request-id")!,
    );
    expect(readEvent).toMatchObject({
      action: "secret.rotated",
      outcome: "success",
      actorType: "api_key",
      actorId: keyId,
      resourceId: "db-password",
    });
    expect(uploadEvent).toMatchObject({
      action: "file.uploaded",
      actorId: keyId,
      resourceId: ((await uploaded.json()) as { id: string }).id,
    });
    const logs = (await dockerCompose(["logs", "--no-color", "gateway"]))
      .stdout;
    expect(logs).toContain(read.headers.get("x-request-id")!);
    const all = await (await auditEvents(key)).text();
    expect(all).not.toContain("e2e-secret-value-audit");
  });

  it("filters, and never shows another tenant's events", async () => {
    const a = await createTenantWithKey("e2e-audit-a");
    const b = await createTenantWithKey("e2e-audit-b");
    await secrets(a.key, "PUT", "/only-a", "e2e-secret-value-a");

    const bEvents = (await (await auditEvents(b.key)).json()) as {
      events: AuditEvent[];
    };
    const aCreated = (await (
      await auditEvents(a.key, "?action=secret.created&resourceId=only-a")
    ).json()) as { events: AuditEvent[] };

    expect(aCreated.events).toHaveLength(1);
    expect(JSON.stringify(bEvents)).not.toContain("only-a");
    expect(bEvents.events.map((e) => e.action).sort()).toEqual([
      "api_key.created",
      "tenant.created",
    ]);
    await expectError(
      await auditEvents(a.key, "?action=secrets.sealed"),
      400,
      "BAD_REQUEST",
    );
  });

  it("simultaneous events still form one valid chain", async () => {
    await freshWindow();
    const { tenantId, key } = await createTenantWithKey("e2e-audit-parallel");
    await secrets(key, "PUT", "/parallel", "e2e-secret-value-parallel");

    const reads = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        secrets(key, "POST", "/parallel/rotate", `e2e-secret-value-p${i}`),
      ),
    );

    expect(reads.every((r) => r.status === 200)).toBe(true);
    const result = await verify(tenantId);
    expect(result.code).toBe(0);
    expect(result.output).toMatch(/OK .* 15 entries intact/);
  });

  it("the platform chain has the seal changes, and every chain verifies", async () => {
    const actions = psql(
      "audit_app",
      "audit",
      "select distinct action from audit_events where chain = 'platform' order by 1",
    );

    expect(actions.output.split("\n")).toEqual(
      expect.arrayContaining(["secrets.initialised", "secrets.unsealed"]),
    );
    const all = await verify("--all");
    expect(all.code).toBe(0);
    expect(all.output).not.toContain("BROKEN");
  });
});

describe("the audit log can't be quietly changed", () => {
  it("the audit service's login can read and add rows, but not change or delete them", () => {
    for (const sql of [
      "update audit_events set outcome = 'denied'",
      "delete from audit_events",
      "truncate audit_events",
      "alter table audit_events add column x int",
      "drop table audit_events",
    ]) {
      const result = psql("audit_app", "audit", sql);
      expect(result.ok, sql).toBe(false);
      expect(result.output).toMatch(/permission denied|must be owner/);
    }
    expect(
      psql("audit_app", "audit", "select count(*) > 0 from audit_events"),
    ).toEqual({
      ok: true,
      output: "t",
    });
  });

  it("a row changed with a privileged login is found by verification (and passes again once restored)", async () => {
    const { tenantId, key } = await createTenantWithKey("e2e-audit-tamper");
    await secrets(key, "PUT", "/tampered", "e2e-secret-value-tamper");
    await secrets(key, "POST", "/tampered/rotate", "e2e-secret-value-tamper2");
    expect((await verify(tenantId)).code).toBe(0);

    const where = `chain = '${tenantId}' and seq = 3`;
    expect(
      psql(
        "platform",
        "audit",
        `update audit_events set outcome = 'denied' where ${where}`,
      ).ok,
    ).toBe(true);
    const broken = await verify(tenantId);
    psql(
      "platform",
      "audit",
      `update audit_events set outcome = 'success' where ${where}`,
    );
    const restored = await verify(tenantId);

    expect(broken.code).toBe(1);
    expect(broken.output).toMatch(
      /BROKEN .* first broken entry is #3 .*changed/,
    );
    expect(restored.code).toBe(0);
  });
});

describe("when the audit service is stopped", () => {
  it("secret and key changes get 503; files keep working (best effort)", async () => {
    await freshWindow();
    const { tenantId, key } = await createTenantWithKey("e2e-audit-down");
    await secrets(key, "PUT", "/while-down", "e2e-secret-value-down");
    const file = randomBytes(2048);

    await dockerCompose(["stop", "audit"]);
    try {
      const read = await secrets(
        key,
        "POST",
        "/while-down/rotate",
        "e2e-secret-value-down-2",
      );
      const newKey = await admin("POST", `/tenants/${tenantId}/api-keys`, {
        name: "no",
      });
      const uploaded = await upload(key, file);
      const { id } = (await uploaded.json()) as { id: string };
      const downloaded = await download(id, `Bearer ${key}`);

      await expectError(read, 503, "SERVICE_UNAVAILABLE");
      expect(await read.text().catch(() => "")).not.toContain(
        "e2e-secret-value-down",
      );
      expect(newKey.status).toBe(503);
      expect(uploaded.status).toBe(201);
      expect(Buffer.from(await downloaded.arrayBuffer()).equals(file)).toBe(
        true,
      );
      let storageLogs = "";
      for (
        let i = 0;
        i < 40 && !storageLogs.includes("AUDIT EVENT LOST");
        i++
      ) {
        await sleep(500);
        storageLogs = (await dockerCompose(["logs", "--no-color", "storage"]))
          .stdout;
      }
      expect(storageLogs).toContain("AUDIT EVENT LOST");
    } finally {
      await dockerCompose(["start", "audit"]);
      await waitForAudit();
    }
    expect(
      (
        await secrets(
          key,
          "POST",
          "/while-down/rotate",
          "e2e-secret-value-down-3",
        )
      ).status,
    ).toBe(200);
  });
});

describe("internal routes", () => {
  it("the audit service can't be reached through the gateway or from the host", async () => {
    const { key } = await createTenantWithKey("e2e-audit-internal");
    for (const path of [
      "/metrics",
      "/v1/metrics",
      "/internal/events",
      "/v1/internal/events",
      "/v1/storage/..%2F..%2Fmetrics",
      "/events",
    ]) {
      const response = await fetch(`${GATEWAY_URL}${path}`, {
        method: path.includes("events") ? "POST" : "GET",
        headers: { authorization: `Bearer ${key}` },
      });
      expect(response.status, path).toBeGreaterThanOrEqual(400);
      expect(await response.text()).not.toMatch(
        /# HELP|http_requests_total|"seq"/,
      );
    }
    for (const port of [3003]) {
      await expect(
        fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(3000),
        }),
      ).rejects.toThrow();
    }
  });

  it("the event route refuses a container without a service's token", async () => {
    const result = await dockerCompose([
      "exec",
      "-T",
      "gateway",
      "node",
      "-e",
      `fetch("http://audit:3003/internal/events", {
        method: "POST",
        headers: { "content-type": "application/json", "x-audit-service": "secrets", authorization: "Bearer not-the-secrets-token-0123456789abcdef" },
        body: JSON.stringify({ action: "secrets.sealed", outcome: "success", actorType: "operator" }),
      }).then(r => console.log(r.status))`,
    ]);

    expect(result.stdout.trim()).toBe("403");
  });
});

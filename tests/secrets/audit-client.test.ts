import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Contract, loadSpec } from "../../api/validate.js";
import { httpAuditTransport } from "../../services/secrets/src/audit.js";

const contract = new Contract(loadSpec("api/internal/audit.openapi.json"));
const SERVICE = "secrets";
const TOKEN = "test-audit-token-0123456789abcdef0123456789";

let server: Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve));
  server = undefined;
});

async function fakeAudit(status: number) {
  const problems: string[] = [];
  const received: { headers: Record<string, unknown>; body: string }[] = [];
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      problems.push(
        ...contract.checkRequest(
          req.method ?? "",
          req.url ?? "",
          req.headers,
          body,
        ),
      );
      res.writeHead(status, { "content-type": "application/json" });
      res.end(
        status === 201
          ? JSON.stringify({ id: randomUUID(), seq: 1 })
          : JSON.stringify({
              error: {
                code: "SERVICE_UNAVAILABLE",
                message: "x",
                requestId: randomUUID(),
              },
            }),
      );
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, problems, received };
}

describe("the audit client meets the audit contract", () => {
  it("sends events the audit service accepts, with this service's name and token", async () => {
    const audit = await fakeAudit(201);
    const { transport, close } = httpAuditTransport({
      url: audit.url,
      service: SERVICE,
      token: TOKEN,
      timeoutMs: 1_000,
    });

    await transport({
      action: "secret.read",
      outcome: "success",
      actorType: "api_key",
      actorId: randomUUID(),
      tenantId: randomUUID(),
      resourceId: "db-password",
      requestId: randomUUID(),
      sourceIp: "198.51.100.4",
    });
    await close();

    expect(audit.problems).toEqual([]);
    expect(audit.received[0]?.headers).toMatchObject({
      "x-audit-service": SERVICE,
      authorization: `Bearer ${TOKEN}`,
    });
  });

  it("rejects when the event wasn't saved, or the service can't be reached", async () => {
    const audit = await fakeAudit(503);
    const failing = httpAuditTransport({
      url: audit.url,
      service: SERVICE,
      token: TOKEN,
      timeoutMs: 1_000,
    });
    const unreachable = httpAuditTransport({
      url: "http://127.0.0.1:1",
      service: SERVICE,
      token: TOKEN,
      timeoutMs: 500,
    });
    const event = {
      action: "secret.deleted",
      outcome: "success",
      actorType: "service",
    } as const;

    await expect(failing.transport(event)).rejects.toThrow(/503/);
    await expect(unreachable.transport(event)).rejects.toThrow();
    await failing.close();
    await unreachable.close();
  });
});

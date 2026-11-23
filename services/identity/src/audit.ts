import type { FastifyBaseLogger } from "fastify";
import { Agent, request as sendRequest } from "undici";

export interface AuditEvent {
  action: string;
  outcome: "success" | "denied" | "failure";
  actorType: "api_key" | "user" | "admin" | "operator" | "service";
  tenantId?: string;
  poolId?: string;
  actorId?: string;
  resourceId?: string;
  requestId?: string;
  sourceIp?: string;
}

export type AuditTransport = (event: AuditEvent) => Promise<void>;

export class AuditUnavailableError extends Error {
  constructor() {
    super("the audit event could not be saved");
    this.name = "AuditUnavailableError";
  }
}

export class AuditClient {
  constructor(
    private readonly transport: AuditTransport,
    private readonly retryDelaysMs: number[] = [200, 800],
  ) {}

  async record(event: AuditEvent, log: FastifyBaseLogger): Promise<void> {
    try {
      await this.transport(event);
    } catch (error) {
      log.error(
        { err: error, action: event.action },
        "audit event could not be saved, so the action was refused",
      );
      throw new AuditUnavailableError();
    }
  }

  async recordBestEffort(
    event: AuditEvent,
    log: FastifyBaseLogger,
  ): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.transport(event);
        return;
      } catch (error) {
        const delay = this.retryDelaysMs[attempt];
        if (delay === undefined) {
          log.warn(
            {
              err: error,
              action: event.action,
              auditRequestId: event.requestId,
            },
            "AUDIT EVENT LOST: it could not be saved after retrying; the action itself went ahead",
          );
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
}

export function httpAuditTransport(options: {
  url: string;
  service: string;
  token: string;
  timeoutMs: number;
}): { transport: AuditTransport; close: () => Promise<void> } {
  const agent = new Agent({
    connectTimeout: options.timeoutMs,
    headersTimeout: options.timeoutMs,
    bodyTimeout: options.timeoutMs,
  });
  const url = `${options.url.replace(/\/$/, "")}/internal/events`;
  return {
    transport: async (event) => {
      const response = await sendRequest(url, {
        dispatcher: agent,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-audit-service": options.service,
          authorization: `Bearer ${options.token}`,
          ...(event.requestId ? { "x-request-id": event.requestId } : {}),
        },
        body: JSON.stringify(event),
      });
      await response.body.dump();
      if (response.statusCode !== 201) {
        throw new Error(`the audit service answered ${response.statusCode}`);
      }
    },
    close: () => agent.close(),
  };
}

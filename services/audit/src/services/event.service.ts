import { isIP } from "node:net";
import {
  ACTIONS,
  PLATFORM_CHAIN,
  poolChain,
  type Action,
  type ActionRule,
  type ServiceName,
} from "../actions.js";
import type { Database } from "../db/client.js";
import type { AuditRow } from "../db/schema.js";
import { AppError } from "../errors.js";
import {
  appendEvent,
  listEvents,
  summarizeEvents,
  type EventFilters,
} from "../models/event.model.js";
import type { EventBody } from "../schemas.js";

const MAX_SUMMARY_MS = 200 * 24 * 60 * 60 * 1000;

export interface EventQuery extends Omit<EventFilters, "beforeSeq"> {
  from?: Date;
  to?: Date;
  cursor?: string;
  limit?: number;
}

export type EventService = ReturnType<typeof createEventService>;

export function createEventService(db: Database, hmacKey: string) {
  return {
    async record(
      caller: ServiceName | undefined,
      event: EventBody,
    ): Promise<AuditRow> {
      const rule: ActionRule = ACTIONS[event.action as Action];
      if (!caller || rule.sentBy !== caller)
        throw new AppError(
          403,
          "FORBIDDEN",
          "This service may not record that action",
        );
      if (
        (rule.chain === "tenant" || rule.chain === "pool") &&
        event.tenantId === undefined
      )
        throw new AppError(400, "BAD_REQUEST", "This action needs a tenantId");
      if (rule.chain === "pool" && event.poolId === undefined)
        throw new AppError(400, "BAD_REQUEST", "This action needs a poolId");
      if (rule.chain !== "pool" && event.poolId !== undefined)
        throw new AppError(
          400,
          "BAD_REQUEST",
          "Only user pool actions take a poolId",
        );
      if (event.sourceIp !== undefined && isIP(event.sourceIp) === 0)
        throw new AppError(
          400,
          "BAD_REQUEST",
          "sourceIp must be an IP address",
        );
      return appendEvent(db, hmacKey, {
        chain: chainOf(rule, event),
        tenantId: event.tenantId ?? null,
        service: caller,
        actorType: event.actorType,
        actorId: event.actorId ?? null,
        action: event.action,
        resourceType: rule.resourceType,
        resourceId: event.resourceId ?? null,
        outcome: event.outcome,
        requestId: event.requestId ?? null,
        sourceIp: event.sourceIp ?? null,
      });
    },

    list(tenantId: string, query: EventQuery) {
      return listChain(tenantId, tenantId, query);
    },

    listPool(tenantId: string, poolId: string, query: EventQuery) {
      return listChain(poolChain(poolId), tenantId, query);
    },

    summary(tenantId: string, from: Date, to: Date) {
      const span = to.getTime() - from.getTime();
      if (Number.isNaN(span) || span <= 0 || span > MAX_SUMMARY_MS)
        throw new AppError(
          400,
          "BAD_REQUEST",
          "from must be before to, at most 200 days apart",
        );
      return summarizeEvents(db, tenantId, from, to);
    },
  };

  async function listChain(chain: string, tenantId: string, query: EventQuery) {
    const { from, to, cursor, limit = 50, ...filters } = query;
    if (Number.isNaN(from?.getTime()) || Number.isNaN(to?.getTime()))
      throw new AppError(
        400,
        "BAD_REQUEST",
        "from and to must be valid timestamps",
      );
    const rows = await listEvents(
      db,
      chain,
      {
        ...filters,
        tenantId,
        from,
        to,
        beforeSeq: cursor === undefined ? undefined : Number(cursor),
      },
      limit + 1,
    );
    const page = rows.slice(0, limit);
    return {
      events: page,
      nextCursor: rows.length > limit ? String(page.at(-1)!.seq) : null,
    };
  }
}

function chainOf(rule: ActionRule, event: EventBody): string {
  if (rule.chain === "pool" && event.poolId) return poolChain(event.poolId);
  if (rule.chain === "platform" || event.tenantId === undefined)
    return PLATFORM_CHAIN;
  return event.tenantId;
}

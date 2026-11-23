import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuditRow } from "../db/schema.js";
import { AppError } from "../errors.js";
import type {
  EventBody,
  EventsQuery,
  PoolParams,
  SummaryQuery,
} from "../schemas.js";
import type { EventService } from "../services/event.service.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function gatewayTenant(request: FastifyRequest): string {
  if (request.caller !== "gateway")
    throw new AppError(403, "FORBIDDEN", "Not allowed");
  const tenantId = request.headers["x-tenant-id"];
  if (typeof tenantId !== "string" || !UUID_PATTERN.test(tenantId))
    throw new AppError(
      400,
      "BAD_REQUEST",
      "A valid X-Tenant-Id header is required",
    );
  return tenantId;
}

function eventJson(row: AuditRow) {
  return {
    id: row.id,
    occurredAt: row.occurredAt.toISOString(),
    actorType: row.actorType,
    actorId: row.actorId,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    outcome: row.outcome,
    requestId: row.requestId,
    sourceIp: row.sourceIp,
  };
}

function eventQuery({ from, to, ...query }: EventsQuery) {
  return {
    ...query,
    from: from === undefined ? undefined : new Date(from),
    to: to === undefined ? undefined : new Date(to),
  };
}

function pageJson(page: { events: AuditRow[]; nextCursor: string | null }) {
  return { events: page.events.map(eventJson), nextCursor: page.nextCursor };
}

export function createEventController(events: EventService) {
  return {
    record: async (
      request: FastifyRequest<{ Body: EventBody }>,
      reply: FastifyReply,
    ) => {
      const row = await events.record(request.caller, request.body);
      return reply.code(201).send({ id: row.id, seq: row.seq });
    },

    list: async (request: FastifyRequest<{ Querystring: EventsQuery }>) =>
      pageJson(
        await events.list(gatewayTenant(request), eventQuery(request.query)),
      ),

    listPool: async (
      request: FastifyRequest<{ Params: PoolParams; Querystring: EventsQuery }>,
    ) =>
      pageJson(
        await events.listPool(
          gatewayTenant(request),
          request.params.poolId,
          eventQuery(request.query),
        ),
      ),

    summary: (request: FastifyRequest<{ Querystring: SummaryQuery }>) =>
      events.summary(
        gatewayTenant(request),
        new Date(request.query.from),
        new Date(request.query.to),
      ),
  };
}

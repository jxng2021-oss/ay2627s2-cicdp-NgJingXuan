import type { FastifyInstance } from "fastify";
import type { createEventController } from "../controllers/event.controller.js";
import { EventBody, EventsQuery, SummaryQuery } from "../schemas.js";

export function eventRoutes(
  app: FastifyInstance,
  controller: ReturnType<typeof createEventController>,
): void {
  app.post(
    "/internal/events",
    { schema: { body: EventBody } },
    controller.record,
  );
  app.get("/events", { schema: { querystring: EventsQuery } }, controller.list);
  app.get(
    "/events/summary",
    { schema: { querystring: SummaryQuery } },
    controller.summary,
  );
}

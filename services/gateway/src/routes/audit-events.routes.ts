import type { FastifyPluginCallback } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { listAuditEventsSchema } from "../api/audit-schemas.js";
import { createAuditEventsController } from "../controllers/audit-events.controller.js";
import { Upstream } from "../services/upstream.service.js";

export interface AuditEventsOptions {
  auditUrl: string;
  auditToken: string;
  connectTimeoutMs: number;
  responseTimeoutMs: number;
}

export const auditEventsRoute: FastifyPluginCallback<AuditEventsOptions> = (
  app,
  options,
  done,
) => {
  const audit = new Upstream({
    label: "Audit service",
    baseUrl: options.auditUrl,
    connectTimeoutMs: options.connectTimeoutMs,
    responseTimeoutMs: options.responseTimeoutMs,
  });
  app.addHook("onClose", () => audit.close());

  const c = createAuditEventsController(audit, options.auditToken);
  app
    .withTypeProvider<TypeBoxTypeProvider>()
    .get("/audit-events", { schema: listAuditEventsSchema }, c.list);
  done();
};

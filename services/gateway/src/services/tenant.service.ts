import type { AuditClient, AuditEvent } from "../audit.js";
import type { Database } from "../db/client.js";
import type { Tenant } from "../db/schema.js";
import {
  createTenant,
  findTenant,
  suspendTenant,
} from "../models/platform.model.js";
import type { FastifyBaseLogger } from "fastify";

export function tenantService(db: Database, audit: AuditClient) {
  return {
    find: (tenantId: string) => findTenant(db, tenantId),

    create: (
      name: string,
      event: (tenantId: string) => AuditEvent,
      log: FastifyBaseLogger,
    ) =>
      db.transaction(async (tx) => {
        const created = await createTenant(tx, name);
        await audit.record(event(created.id), log);
        return created;
      }),

    suspend: (
      tenantId: string,
      event: AuditEvent,
      log: FastifyBaseLogger,
    ): Promise<Tenant | undefined> =>
      db.transaction(async (tx) => {
        const suspended = await suspendTenant(tx, tenantId);
        if (suspended) await audit.record(event, log);
        return suspended;
      }),
  };
}

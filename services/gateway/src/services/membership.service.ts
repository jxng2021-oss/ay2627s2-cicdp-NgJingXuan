import type { FastifyBaseLogger } from "fastify";
import type { AuditClient, AuditEvent } from "../audit.js";
import type { Database } from "../db/client.js";
import {
  countOwners,
  deleteMembership,
  findMembership,
} from "../models/membership.model.js";

export function membershipService(db: Database, audit: AuditClient) {
  return {
    find: (userId: string, tenantId: string) =>
      findMembership(db, userId, tenantId),

    isOnlyOwner: async (tenantId: string) =>
      (await countOwners(db, tenantId)) === 1,

    leave: (
      userId: string,
      tenantId: string,
      event: AuditEvent,
      log: FastifyBaseLogger,
    ) =>
      db.transaction(async (tx) => {
        await deleteMembership(tx, userId, tenantId);
        await audit.record(event, log);
      }),
  };
}

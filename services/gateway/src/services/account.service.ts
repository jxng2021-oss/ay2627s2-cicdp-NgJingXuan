import type { FastifyBaseLogger } from "fastify";
import type { AuditClient, AuditEvent } from "../audit.js";
import type { Database } from "../db/client.js";
import {
  insertMembership,
  listMemberships,
  soleOwnerOf,
} from "../models/membership.model.js";
import { createTenant } from "../models/platform.model.js";
import {
  listUserSessions,
  revokeSession,
  revokeUserSession,
  revokeUserSessions,
} from "../models/session.model.js";
import {
  deleteUser,
  findUserById,
  updateDisplayName,
} from "../models/user.model.js";

export function accountService(db: Database, audit: AuditClient) {
  return {
    async profile(userId: string) {
      const user = await findUserById(db, userId);
      const workspaces = await listMemberships(db, userId);
      return { user, workspaces };
    },

    setDisplayName: (userId: string, name: string | null) =>
      updateDisplayName(db, userId, name),

    listSessions: (userId: string, idleTimeoutMs: number) =>
      listUserSessions(db, userId, idleTimeoutMs),

    endSession: (sessionId: string) => revokeSession(db, sessionId),

    endUserSession: (userId: string, sessionId: string) =>
      revokeUserSession(db, userId, sessionId),

    endAllSessions: (userId: string) => revokeUserSessions(db, userId),

    async soleOwnedWorkspace(userId: string) {
      const [sole] = await soleOwnerOf(db, userId);
      return sole;
    },

    async ownedWorkspaceCount(userId: string) {
      return (await listMemberships(db, userId)).filter(
        (w) => w.role === "owner",
      ).length;
    },

    deleteAccount: (
      userId: string,
      event: (tenantId: string) => AuditEvent,
      log: FastifyBaseLogger,
    ) =>
      db.transaction(async (tx) => {
        for (const workspace of await listMemberships(tx, userId)) {
          await audit.record(event(workspace.tenantId), log);
        }
        await deleteUser(tx, userId);
      }),

    createWorkspace: (
      userId: string,
      name: string,
      event: (tenantId: string) => AuditEvent,
      log: FastifyBaseLogger,
    ) =>
      db.transaction(async (tx) => {
        const created = await createTenant(tx, name);
        await insertMembership(tx, {
          userId,
          tenantId: created.id,
          role: "owner",
        });
        await audit.record(event(created.id), log);
        return created;
      }),
  };
}

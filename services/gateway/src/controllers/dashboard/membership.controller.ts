import type { FastifyReply, FastifyRequest } from "fastify";
import { sendError } from "../../errors.js";
import type { DashboardOptions } from "../../routes/dashboard/index.js";
import { userEvent } from "../../services/auth.service.js";
import { membershipService } from "../../services/membership.service.js";

export function membershipController(options: DashboardOptions) {
  const memberships = membershipService(options.db, options.audit);
  return {
    leave: async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.dashboardUserId!;
      const workspace = request.dashboardWorkspace!;
      if (
        workspace.role === "owner" &&
        (await memberships.isOnlyOwner(workspace.tenantId))
      ) {
        return sendError(
          reply,
          409,
          "CONFLICT",
          "You are this workspace's only owner: delete it instead",
        );
      }
      await memberships.leave(
        userId,
        workspace.tenantId,
        userEvent(request, "membership.removed", userId, workspace.tenantId),
        request.log,
      );
      return reply.code(204).send();
    },
  };
}

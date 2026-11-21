import type { FastifyReply, FastifyRequest } from "fastify";
import { sendError } from "../../errors.js";
import type { DashboardOptions } from "../../routes/dashboard/index.js";
import {
  workspaceDeletionService,
  type DeletionServices,
} from "../../services/workspace-deletion.service.js";

export function workspaceDeletionController(
  options: DashboardOptions,
  services: DeletionServices,
) {
  const deleteWorkspace = workspaceDeletionService(
    options.db,
    options.audit,
    services,
  );

  return async (
    request: FastifyRequest<{ Body: { confirmName: string } }>,
    reply: FastifyReply,
  ) => {
    const workspace = request.dashboardWorkspace!;
    if (request.body.confirmName !== workspace.name) {
      return sendError(
        reply,
        400,
        "BAD_REQUEST",
        "Type the workspace's exact name to confirm",
      );
    }
    const refused = await deleteWorkspace(
      request,
      workspace.status === "deleting",
    );
    if (refused) {
      if (refused.retryAfter) reply.header("retry-after", refused.retryAfter);
      return sendError(reply, refused.status, refused.code, refused.message);
    }
    return reply.code(204).send();
  };
}

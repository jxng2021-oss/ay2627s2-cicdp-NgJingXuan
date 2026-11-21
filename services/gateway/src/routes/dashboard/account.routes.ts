import type { FastifyPluginCallback } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { strictValidatorCompiler } from "../../validation.js";
import { authController } from "../../controllers/dashboard/auth.controller.js";
import {
  createWorkspaceSchema,
  deleteAccountSchema,
  listSessionsSchema,
  revokeSessionSchema,
  updateProfileSchema,
} from "../../api/dashboard-schemas.js";
import type { DashboardOptions } from "./index.js";

export const accountRoutes: FastifyPluginCallback<DashboardOptions> = (
  app,
  options,
  done,
) => {
  app.setValidatorCompiler(strictValidatorCompiler);
  app.removeContentTypeParser("text/plain");
  const account = authController(options);
  const api = app.withTypeProvider<TypeBoxTypeProvider>();

  api.patch(
    "/account/profile",
    { schema: updateProfileSchema },
    account.updateProfile,
  );
  api.get(
    "/account/sessions",
    { schema: listSessionsSchema },
    account.sessions,
  );
  api.delete(
    "/account/sessions/:sessionId",
    { schema: revokeSessionSchema },
    account.revokeSession,
  );
  api.post(
    "/account/delete",
    { schema: deleteAccountSchema },
    account.deleteAccount,
  );
  api.post(
    "/workspaces",
    { schema: createWorkspaceSchema },
    account.createWorkspace,
  );
  done();
};

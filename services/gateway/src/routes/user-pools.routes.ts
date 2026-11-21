import type { FastifyPluginCallback } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import {
  jwksSchema,
  addUserRoleSchema,
  changePasswordSchema,
  createRoleSchema,
  deleteRoleSchema,
  getPoolUserSchema,
  getRoleSchema,
  listRolesSchema,
  refreshSchema,
  removeUserRoleSchema,
  signInSchema,
  signOutSchema,
  signUpSchema,
  updateRoleSchema,
} from "../api/user-pool-schemas.js";
import {
  createUserPoolKeysController,
  createUserPoolsController,
} from "../controllers/user-pools.controller.js";
import { Upstream } from "../services/upstream.service.js";
import {
  userPoolsForwarder,
  type UserPoolsOptions,
} from "../services/user-pools.service.js";
import { strictValidatorCompiler } from "../validation.js";

export const userPoolRoutes: FastifyPluginCallback<UserPoolsOptions> = (
  app,
  options,
  done,
) => {
  const pools = userPoolsForwarder(options);
  app.addHook("onClose", pools.close);
  const c = createUserPoolsController(pools);
  app.setValidatorCompiler(strictValidatorCompiler);
  app.removeContentTypeParser("text/plain");
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("cache-control", "no-store");
  });
  const api = app.withTypeProvider<TypeBoxTypeProvider>();
  const bodyLimit = 16 * 1024;

  api.post(
    "/user-pools/:poolId/users",
    { schema: signUpSchema, bodyLimit },
    c.signUp,
  );
  api.get(
    "/user-pools/:poolId/users/:userId",
    { schema: getPoolUserSchema },
    c.getPoolUser,
  );
  api.post(
    "/user-pools/:poolId/users/:userId/password",
    { schema: changePasswordSchema, bodyLimit },
    c.changePassword,
  );
  api.post(
    "/user-pools/:poolId/sessions",
    { schema: signInSchema, bodyLimit },
    c.signIn,
  );
  api.post(
    "/user-pools/:poolId/sessions/refresh",
    { schema: refreshSchema, bodyLimit },
    c.refresh,
  );
  api.get(
    "/user-pools/:poolId/roles",
    { schema: listRolesSchema },
    c.listRoles,
  );
  api.post(
    "/user-pools/:poolId/roles",
    { schema: createRoleSchema, bodyLimit },
    c.createRole,
  );
  api.get(
    "/user-pools/:poolId/roles/:role",
    { schema: getRoleSchema },
    c.getRole,
  );
  api.patch(
    "/user-pools/:poolId/roles/:role",
    { schema: updateRoleSchema, bodyLimit },
    c.updateRole,
  );
  api.delete(
    "/user-pools/:poolId/roles/:role",
    { schema: deleteRoleSchema },
    c.deleteRole,
  );
  api.put(
    "/user-pools/:poolId/users/:userId/roles/:role",
    { schema: addUserRoleSchema },
    c.addUserRole,
  );
  api.delete(
    "/user-pools/:poolId/users/:userId/roles/:role",
    { schema: removeUserRoleSchema },
    c.removeUserRole,
  );

  api.post(
    "/user-pools/:poolId/sessions/revoke",
    { schema: signOutSchema, bodyLimit },
    c.signOut,
  );
  done();
};

export const userPoolKeysRoute: FastifyPluginCallback<UserPoolsOptions> = (
  app,
  options,
  done,
) => {
  const identity = new Upstream({
    label: "Identity service",
    baseUrl: options.identityUrl,
    connectTimeoutMs: options.connectTimeoutMs,
    responseTimeoutMs: options.responseTimeoutMs,
  });
  app.addHook("onClose", () => identity.close());
  const c = createUserPoolKeysController(identity);
  app
    .withTypeProvider<TypeBoxTypeProvider>()
    .get("/user-pools/:poolId/jwks.json", { schema: jwksSchema }, c.jwks);
  done();
};

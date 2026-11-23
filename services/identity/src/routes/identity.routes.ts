import type { FastifyInstance } from "fastify";
import type { createIdentityController } from "../controllers/identity.controller.js";
import {
  ChangePasswordBody,
  LoginBody,
  NewPoolBody,
  NewRoleBody,
  PoolChangesBody,
  PoolParams,
  RefreshBody,
  RoleChangesBody,
  RoleParams,
  SignUpBody,
  UserChangesBody,
  UserListQuery,
  UserParams,
  UserRoleParams,
} from "../schemas.js";

export function identityRoutes(
  app: FastifyInstance,
  c: ReturnType<typeof createIdentityController>,
): void {
  app.get("/pools", c.listPools);
  app.post("/pools", { schema: { body: NewPoolBody } }, c.createPool);
  app.get("/pools/:poolId", { schema: { params: PoolParams } }, c.getPool);
  app.patch(
    "/pools/:poolId",
    { schema: { params: PoolParams, body: PoolChangesBody } },
    c.updatePool,
  );
  app.delete(
    "/pools/:poolId",
    { schema: { params: PoolParams } },
    c.removePool,
  );

  app.post(
    "/pools/:poolId/users",
    { schema: { params: PoolParams, body: SignUpBody } },
    c.signUp,
  );
  app.get(
    "/pools/:poolId/users",
    { schema: { params: PoolParams, querystring: UserListQuery } },
    c.listUsers,
  );
  app.get(
    "/pools/:poolId/users/:userId",
    { schema: { params: UserParams } },
    c.getUser,
  );
  app.patch(
    "/pools/:poolId/users/:userId",
    { schema: { params: UserParams, body: UserChangesBody } },
    c.updateUser,
  );
  app.delete(
    "/pools/:poolId/users/:userId",
    { schema: { params: UserParams } },
    c.removeUser,
  );
  app.post(
    "/pools/:poolId/users/:userId/reset-password",
    { schema: { params: UserParams } },
    c.resetPassword,
  );
  app.post(
    "/pools/:poolId/users/:userId/unlock",
    { schema: { params: UserParams } },
    c.unlockUser,
  );
  app.post(
    "/pools/:poolId/users/:userId/password",
    { schema: { params: UserParams, body: ChangePasswordBody } },
    c.changePassword,
  );

  app.post(
    "/pools/:poolId/sessions",
    { schema: { params: PoolParams, body: LoginBody } },
    c.login,
  );
  app.post(
    "/pools/:poolId/sessions/refresh",
    { schema: { params: PoolParams, body: RefreshBody } },
    c.refresh,
  );
  app.post(
    "/pools/:poolId/sessions/revoke",
    { schema: { params: PoolParams, body: RefreshBody } },
    c.revoke,
  );

  app.get(
    "/pools/:poolId/roles",
    { schema: { params: PoolParams } },
    c.listRoles,
  );
  app.post(
    "/pools/:poolId/roles",
    { schema: { params: PoolParams, body: NewRoleBody } },
    c.createRole,
  );
  app.get(
    "/pools/:poolId/roles/:role",
    { schema: { params: RoleParams } },
    c.getRole,
  );
  app.patch(
    "/pools/:poolId/roles/:role",
    { schema: { params: RoleParams, body: RoleChangesBody } },
    c.updateRole,
  );
  app.delete(
    "/pools/:poolId/roles/:role",
    { schema: { params: RoleParams } },
    c.removeRole,
  );
  app.put(
    "/pools/:poolId/users/:userId/roles/:role",
    { schema: { params: UserRoleParams } },
    c.addUserRole,
  );
  app.delete(
    "/pools/:poolId/users/:userId/roles/:role",
    { schema: { params: UserRoleParams } },
    c.removeUserRole,
  );

  app.get(
    "/public/pools/:poolId/jwks",
    { schema: { params: PoolParams } },
    c.jwks,
  );
  app.delete("/tenant", c.removeTenant);
}

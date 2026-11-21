import type * as schemas from "../../api/dashboard-schemas.js";
import {
  poolPath,
  roleBody,
  rolePath,
  userPath,
  userRolePath,
  type UserPoolsForwarder,
} from "../../services/user-pools.service.js";
import type { Rep, Req } from "../../types.js";

export function dashboardPoolsController(pools: UserPoolsForwarder["forward"]) {
  return {
    listPools: (
      request: Req<typeof schemas.listPoolsSchema>,
      reply: Rep<typeof schemas.listPoolsSchema>,
    ) => pools(request, reply, "GET", "/pools"),

    createPool: (
      request: Req<typeof schemas.createPoolSchema>,
      reply: Rep<typeof schemas.createPoolSchema>,
    ) => pools(request, reply, "POST", "/pools", request.body),

    getPool: (
      request: Req<typeof schemas.getPoolSchema>,
      reply: Rep<typeof schemas.getPoolSchema>,
    ) => pools(request, reply, "GET", poolPath(request.params.poolId)),

    updatePool: (
      request: Req<typeof schemas.updatePoolSchema>,
      reply: Rep<typeof schemas.updatePoolSchema>,
    ) =>
      pools(
        request,
        reply,
        "PATCH",
        poolPath(request.params.poolId),
        request.body,
      ),

    deletePool: (
      request: Req<typeof schemas.deletePoolSchema>,
      reply: Rep<typeof schemas.deletePoolSchema>,
    ) => pools(request, reply, "DELETE", poolPath(request.params.poolId)),

    listPoolRoles: (
      request: Req<typeof schemas.listPoolRolesSchema>,
      reply: Rep<typeof schemas.listPoolRolesSchema>,
    ) => pools(request, reply, "GET", rolePath(request.params.poolId)),

    createPoolRole: (
      request: Req<typeof schemas.createPoolRoleSchema>,
      reply: Rep<typeof schemas.createPoolRoleSchema>,
    ) =>
      pools(
        request,
        reply,
        "POST",
        rolePath(request.params.poolId),
        roleBody(request.body),
      ),

    updatePoolRole: (
      request: Req<typeof schemas.updatePoolRoleSchema>,
      reply: Rep<typeof schemas.updatePoolRoleSchema>,
    ) =>
      pools(
        request,
        reply,
        "PATCH",
        rolePath(request.params.poolId, request.params.role),
        roleBody(request.body),
      ),

    deletePoolRole: (
      request: Req<typeof schemas.deletePoolRoleSchema>,
      reply: Rep<typeof schemas.deletePoolRoleSchema>,
    ) =>
      pools(
        request,
        reply,
        "DELETE",
        rolePath(request.params.poolId, request.params.role),
      ),

    addPoolUserRole: (
      request: Req<typeof schemas.addPoolUserRoleSchema>,
      reply: Rep<typeof schemas.addPoolUserRoleSchema>,
    ) =>
      pools(
        request,
        reply,
        "PUT",
        userRolePath(
          request.params.poolId,
          request.params.userId,
          request.params.role,
        ),
      ),

    removePoolUserRole: (
      request: Req<typeof schemas.removePoolUserRoleSchema>,
      reply: Rep<typeof schemas.removePoolUserRoleSchema>,
    ) =>
      pools(
        request,
        reply,
        "DELETE",
        userRolePath(
          request.params.poolId,
          request.params.userId,
          request.params.role,
        ),
      ),

    listPoolUsers: (
      request: Req<typeof schemas.listPoolUsersSchema>,
      reply: Rep<typeof schemas.listPoolUsersSchema>,
    ) =>
      pools(
        request,
        reply,
        "GET",
        poolPath(request.params.poolId, "/users"),
        undefined,
        {
          limit: request.query.limit,
          cursor: request.query.cursor,
          email: request.query.email,
        },
      ),

    getPoolUserDashboard: (
      request: Req<typeof schemas.getPoolUserDashboardSchema>,
      reply: Rep<typeof schemas.getPoolUserDashboardSchema>,
    ) =>
      pools(
        request,
        reply,
        "GET",
        userPath(request.params.poolId, request.params.userId),
      ),

    updatePoolUser: (
      request: Req<typeof schemas.updatePoolUserSchema>,
      reply: Rep<typeof schemas.updatePoolUserSchema>,
    ) =>
      pools(
        request,
        reply,
        "PATCH",
        userPath(request.params.poolId, request.params.userId),
        { status: request.body.status },
      ),

    deletePoolUser: (
      request: Req<typeof schemas.deletePoolUserSchema>,
      reply: Rep<typeof schemas.deletePoolUserSchema>,
    ) =>
      pools(
        request,
        reply,
        "DELETE",
        userPath(request.params.poolId, request.params.userId),
      ),

    resetPoolUserPassword: (
      request: Req<typeof schemas.resetPoolUserPasswordSchema>,
      reply: Rep<typeof schemas.resetPoolUserPasswordSchema>,
    ) =>
      pools(
        request,
        reply,
        "POST",
        userPath(
          request.params.poolId,
          request.params.userId,
          "/reset-password",
        ),
      ),
  };
}

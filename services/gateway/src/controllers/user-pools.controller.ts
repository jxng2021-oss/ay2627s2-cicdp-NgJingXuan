import type {
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
import type { Upstream } from "../services/upstream.service.js";
import {
  poolPath,
  roleBody,
  rolePath,
  userPath,
  userRolePath,
  type UserPoolsForwarder,
} from "../services/user-pools.service.js";
import type { Rep, Req } from "../types.js";

export function createUserPoolsController({ forward }: UserPoolsForwarder) {
  return {
    signUp: (
      request: Req<typeof signUpSchema>,
      reply: Rep<typeof signUpSchema>,
    ) =>
      forward(
        request,
        reply,
        "POST",
        poolPath(request.params.poolId, "/users"),
        {
          email: request.body.email,
          password: request.body.password,
          ...(request.body.attributes
            ? { attributes: request.body.attributes }
            : {}),
        },
      ),

    getPoolUser: (
      request: Req<typeof getPoolUserSchema>,
      reply: Rep<typeof getPoolUserSchema>,
    ) =>
      forward(
        request,
        reply,
        "GET",
        userPath(request.params.poolId, request.params.userId),
      ),

    changePassword: (
      request: Req<typeof changePasswordSchema>,
      reply: Rep<typeof changePasswordSchema>,
    ) =>
      forward(
        request,
        reply,
        "POST",
        userPath(request.params.poolId, request.params.userId, "/password"),
        {
          currentPassword: request.body.currentPassword,
          newPassword: request.body.newPassword,
        },
      ),

    signIn: (
      request: Req<typeof signInSchema>,
      reply: Rep<typeof signInSchema>,
    ) =>
      forward(
        request,
        reply,
        "POST",
        poolPath(request.params.poolId, "/sessions"),
        {
          email: request.body.email,
          password: request.body.password,
        },
      ),

    refresh: (
      request: Req<typeof refreshSchema>,
      reply: Rep<typeof refreshSchema>,
    ) =>
      forward(
        request,
        reply,
        "POST",
        poolPath(request.params.poolId, "/sessions/refresh"),
        { refreshToken: request.body.refreshToken },
      ),

    listRoles: (
      request: Req<typeof listRolesSchema>,
      reply: Rep<typeof listRolesSchema>,
    ) => forward(request, reply, "GET", rolePath(request.params.poolId)),

    createRole: (
      request: Req<typeof createRoleSchema>,
      reply: Rep<typeof createRoleSchema>,
    ) =>
      forward(
        request,
        reply,
        "POST",
        rolePath(request.params.poolId),
        roleBody(request.body),
      ),

    getRole: (
      request: Req<typeof getRoleSchema>,
      reply: Rep<typeof getRoleSchema>,
    ) =>
      forward(
        request,
        reply,
        "GET",
        rolePath(request.params.poolId, request.params.role),
      ),

    updateRole: (
      request: Req<typeof updateRoleSchema>,
      reply: Rep<typeof updateRoleSchema>,
    ) =>
      forward(
        request,
        reply,
        "PATCH",
        rolePath(request.params.poolId, request.params.role),
        roleBody(request.body),
      ),

    deleteRole: (
      request: Req<typeof deleteRoleSchema>,
      reply: Rep<typeof deleteRoleSchema>,
    ) =>
      forward(
        request,
        reply,
        "DELETE",
        rolePath(request.params.poolId, request.params.role),
      ),

    addUserRole: (
      request: Req<typeof addUserRoleSchema>,
      reply: Rep<typeof addUserRoleSchema>,
    ) =>
      forward(
        request,
        reply,
        "PUT",
        userRolePath(
          request.params.poolId,
          request.params.userId,
          request.params.role,
        ),
      ),

    removeUserRole: (
      request: Req<typeof removeUserRoleSchema>,
      reply: Rep<typeof removeUserRoleSchema>,
    ) =>
      forward(
        request,
        reply,
        "DELETE",
        userRolePath(
          request.params.poolId,
          request.params.userId,
          request.params.role,
        ),
      ),

    signOut: (
      request: Req<typeof signOutSchema>,
      reply: Rep<typeof signOutSchema>,
    ) =>
      forward(
        request,
        reply,
        "POST",
        poolPath(request.params.poolId, "/sessions/revoke"),
        { refreshToken: request.body.refreshToken },
      ),
  };
}

export function createUserPoolKeysController(identity: Upstream) {
  return {
    jwks: (request: Req<typeof jwksSchema>, reply: Rep<typeof jwksSchema>) =>
      identity.forward(request, reply, {
        method: "GET",
        path: `/public/pools/${encodeURIComponent(request.params.poolId)}/jwks`,
        headers: {},
      }),
  };
}

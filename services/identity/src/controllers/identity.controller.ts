import type { FastifyReply, FastifyRequest } from "fastify";
import type { Static } from "typebox";
import type { Pool, PoolRole, PoolUser } from "../db/schema.js";
import type {
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
import type { Actor } from "../services/context.js";
import type { PoolService } from "../services/pool.service.js";
import type { RoleService } from "../services/role.service.js";
import { issuerOf, type SessionService } from "../services/session.service.js";
import type { UserService, UserWithRoles } from "../services/user.service.js";

type Req<P, B = unknown, Q = unknown> = FastifyRequest<{
  Params: P;
  Body: B;
  Querystring: Q;
}>;
type PoolP = Static<typeof PoolParams>;
type UserP = Static<typeof UserParams>;
type RoleP = Static<typeof RoleParams>;
type UserRoleP = Static<typeof UserRoleParams>;

export interface IdentityServices {
  pools: PoolService;
  users: UserService;
  sessions: SessionService;
  roles: RoleService;
  publicBaseUrl: string;
  now: () => number;
}

export function actorOf(request: FastifyRequest): Actor {
  return {
    tenantId: request.tenantId,
    actorId: request.actorId,
    actorType: request.actorType,
    clientIp: request.clientIp,
    requestId: request.id,
    log: request.log,
  };
}

export function createIdentityController(services: IdentityServices) {
  const { pools, users, sessions, roles, publicBaseUrl, now } = services;

  const poolJson = (pool: Pool & { userCount: number }) => {
    const issuer = issuerOf(publicBaseUrl, pool.id);
    return {
      id: pool.id,
      name: pool.name,
      accessTokenTtlSeconds: pool.accessTokenTtlSeconds,
      refreshTokenTtlSeconds: pool.refreshTokenTtlSeconds,
      minPasswordLength: pool.minPasswordLength,
      userCount: pool.userCount,
      issuer,
      jwksUrl: `${issuer}/jwks.json`,
      createdAt: pool.createdAt.toISOString(),
    };
  };

  const userJson = ({ user, roles }: { user: PoolUser; roles: string[] }) => ({
    id: user.id,
    email: user.email,
    status: user.status,
    locked: user.lockedUntil !== null && user.lockedUntil.getTime() > now(),
    attributes: user.attributes,
    roles,
    createdAt: user.createdAt.toISOString(),
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
  });

  const roleJson = (role: PoolRole & { userCount: number }) => ({
    name: role.name,
    description: role.description,
    permissions: role.permissions,
    userCount: role.userCount,
    createdAt: role.createdAt.toISOString(),
    updatedAt: role.updatedAt.toISOString(),
  });

  const tokensJson = (
    tokens: Awaited<ReturnType<SessionService["login"]>>,
  ) => ({
    accessToken: tokens.accessToken,
    tokenType: tokens.tokenType,
    expiresIn: tokens.expiresIn,
    refreshToken: tokens.refreshToken,
    user: userJson(tokens),
  });

  const noContent = (reply: FastifyReply) => reply.code(204).send();

  return {
    listPools: async (request: FastifyRequest) => ({
      pools: (await pools.list(actorOf(request))).map(poolJson),
    }),

    createPool: async (
      request: Req<unknown, Static<typeof NewPoolBody>>,
      reply: FastifyReply,
    ) =>
      reply
        .code(201)
        .send(poolJson(await pools.create(actorOf(request), request.body))),

    getPool: async (request: Req<PoolP>) =>
      poolJson(await pools.get(actorOf(request), request.params.poolId)),

    updatePool: async (request: Req<PoolP, Static<typeof PoolChangesBody>>) =>
      poolJson(
        await pools.update(
          actorOf(request),
          request.params.poolId,
          request.body,
        ),
      ),

    removePool: async (request: Req<PoolP>, reply: FastifyReply) => {
      await pools.remove(actorOf(request), request.params.poolId);
      return noContent(reply);
    },

    signUp: async (
      request: Req<PoolP, Static<typeof SignUpBody>>,
      reply: FastifyReply,
    ) =>
      reply
        .code(201)
        .send(
          userJson(
            await users.signUp(
              actorOf(request),
              request.params.poolId,
              request.body,
            ),
          ),
        ),

    listUsers: async (
      request: Req<PoolP, unknown, Static<typeof UserListQuery>>,
    ) => {
      const page = await users.list(
        actorOf(request),
        request.params.poolId,
        request.query,
      );
      return {
        users: page.users.map((entry: UserWithRoles) => userJson(entry)),
        nextCursor: page.nextCursor,
      };
    },

    getUser: async (request: Req<UserP>) =>
      userJson(
        await users.get(
          actorOf(request),
          request.params.poolId,
          request.params.userId,
        ),
      ),

    updateUser: async (request: Req<UserP, Static<typeof UserChangesBody>>) =>
      userJson(
        await users.update(
          actorOf(request),
          request.params.poolId,
          request.params.userId,
          request.body,
        ),
      ),

    removeUser: async (request: Req<UserP>, reply: FastifyReply) => {
      await users.remove(
        actorOf(request),
        request.params.poolId,
        request.params.userId,
      );
      return noContent(reply);
    },

    resetPassword: async (request: Req<UserP>) => ({
      temporaryPassword: await users.resetPassword(
        actorOf(request),
        request.params.poolId,
        request.params.userId,
      ),
    }),

    changePassword: async (
      request: Req<UserP, Static<typeof ChangePasswordBody>>,
      reply: FastifyReply,
    ) => {
      await users.changePassword(
        actorOf(request),
        request.params.poolId,
        request.params.userId,
        request.body.currentPassword,
        request.body.newPassword,
      );
      return noContent(reply);
    },

    login: async (request: Req<PoolP, Static<typeof LoginBody>>) =>
      tokensJson(
        await sessions.login(
          actorOf(request),
          request.params.poolId,
          request.body.email,
          request.body.password,
        ),
      ),

    refresh: async (request: Req<PoolP, Static<typeof RefreshBody>>) =>
      tokensJson(
        await sessions.refresh(
          actorOf(request),
          request.params.poolId,
          request.body.refreshToken,
        ),
      ),

    revoke: async (
      request: Req<PoolP, Static<typeof RefreshBody>>,
      reply: FastifyReply,
    ) => {
      await sessions.revoke(
        actorOf(request),
        request.params.poolId,
        request.body.refreshToken,
      );
      return noContent(reply);
    },

    listRoles: async (request: Req<PoolP>) => ({
      roles: (await roles.list(actorOf(request), request.params.poolId)).map(
        roleJson,
      ),
    }),

    createRole: async (
      request: Req<PoolP, Static<typeof NewRoleBody>>,
      reply: FastifyReply,
    ) =>
      reply
        .code(201)
        .send(
          roleJson(
            await roles.create(
              actorOf(request),
              request.params.poolId,
              request.body,
            ),
          ),
        ),

    getRole: async (request: Req<RoleP>) =>
      roleJson(
        await roles.get(
          actorOf(request),
          request.params.poolId,
          request.params.role,
        ),
      ),

    updateRole: async (request: Req<RoleP, Static<typeof RoleChangesBody>>) =>
      roleJson(
        await roles.update(
          actorOf(request),
          request.params.poolId,
          request.params.role,
          request.body,
        ),
      ),

    removeRole: async (request: Req<RoleP>, reply: FastifyReply) => {
      await roles.remove(
        actorOf(request),
        request.params.poolId,
        request.params.role,
      );
      return noContent(reply);
    },

    addUserRole: async (request: Req<UserRoleP>) =>
      userJson(
        await roles.addToUser(
          actorOf(request),
          request.params.poolId,
          request.params.userId,
          request.params.role,
        ),
      ),

    removeUserRole: async (request: Req<UserRoleP>) =>
      userJson(
        await roles.removeFromUser(
          actorOf(request),
          request.params.poolId,
          request.params.userId,
          request.params.role,
        ),
      ),

    jwks: async (request: Req<PoolP>, reply: FastifyReply) => {
      const keys = await pools.jwks(request.params.poolId);
      reply.header("cache-control", "public, max-age=300");
      return { keys };
    },

    removeTenant: async (request: FastifyRequest, reply: FastifyReply) => {
      await pools.removeTenant(actorOf(request));
      request.log.info("the tenant's user pools were deleted");
      return noContent(reply);
    },
  };
}

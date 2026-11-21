import { randomBytes } from "node:crypto";
import type { PoolUser } from "../db/schema.js";
import { AppError } from "../errors.js";
import {
  deleteUser,
  findUser,
  insertUser,
  listUsers,
  revokeUserSessions,
  rolesOfUsers,
  updateUser,
  userRoles,
} from "../models/identity.model.js";
import { hashPassword, passwordProblem, verifyPassword } from "../passwords.js";
import type { Attributes } from "../schemas.js";
import {
  auditEvent,
  normalizeEmail,
  poolOf,
  recorder,
  userNotFound,
  type Actor,
  type IdentityDeps,
} from "./context.js";

export interface UserWithRoles {
  user: PoolUser;
  roles: string[];
}

export interface UserChanges {
  status?: "active" | "disabled";
  attributes?: Attributes;
}

export type UserService = ReturnType<typeof createUserService>;

export function createUserService(deps: IdentityDeps) {
  const { db } = deps;
  const recorded = recorder(deps);

  const withRoles = async (user: PoolUser): Promise<UserWithRoles> => ({
    user,
    roles: (await userRoles(db, user.id)).map((role) => role.name),
  });

  const checkPassword = (password: string, minLength: number) => {
    const problem = passwordProblem(password, minLength);
    if (problem) throw new AppError(400, "BAD_REQUEST", problem);
  };

  return {
    withRoles,

    async signUp(
      actor: Actor,
      poolId: string,
      input: { email: string; password: string; attributes?: Attributes },
    ): Promise<UserWithRoles> {
      const pool = await poolOf(db, actor, poolId);
      checkPassword(input.password, pool.minPasswordLength);
      const passwordHash = await hashPassword(input.password);
      const user = await recorded(
        actor,
        (tx) =>
          insertUser(tx, {
            poolId: pool.id,
            email: normalizeEmail(input.email),
            passwordHash,
            status: "active",
            attributes: input.attributes ?? {},
          }),
        (saved) =>
          auditEvent(actor, "pool_user.signed_up", "success", saved.id),
      );
      if (!user)
        throw new AppError(
          409,
          "CONFLICT",
          "A user with this email already exists",
        );
      return { user, roles: [] };
    },

    async list(
      actor: Actor,
      poolId: string,
      query: { limit?: number; cursor?: string; email?: string },
    ) {
      const pool = await poolOf(db, actor, poolId);
      const limit = query.limit ?? 50;
      const users = await listUsers(db, pool.id, {
        limit: limit + 1,
        cursor: query.cursor,
        email: query.email,
      });
      const page = users.slice(0, limit);
      const roles = await rolesOfUsers(
        db,
        page.map((user) => user.id),
      );
      return {
        users: page.map((user) => ({ user, roles: roles.get(user.id) ?? [] })),
        nextCursor: users.length > limit ? page.at(-1)!.id : null,
      };
    },

    async get(actor: Actor, poolId: string, userId: string) {
      const pool = await poolOf(db, actor, poolId);
      const user = await findUser(db, pool.id, userId);
      if (!user) throw userNotFound();
      return withRoles(user);
    },

    async update(
      actor: Actor,
      poolId: string,
      userId: string,
      changes: UserChanges,
    ) {
      const pool = await poolOf(db, actor, poolId);
      const user = await recorded(
        actor,
        async (tx) => {
          const changed = await updateUser(tx, pool.id, userId, changes);
          if (changed && changes.status === "disabled") {
            await revokeUserSessions(tx, changed.id);
          }
          return changed;
        },
        (saved) => auditEvent(actor, "pool_user.updated", "success", saved.id),
      );
      if (!user) throw userNotFound();
      return withRoles(user);
    },

    async remove(actor: Actor, poolId: string, userId: string): Promise<void> {
      const pool = await poolOf(db, actor, poolId);
      const deleted = await recorded(
        actor,
        async (tx) =>
          (await deleteUser(tx, pool.id, userId)) ? userId : undefined,
        (id) => auditEvent(actor, "pool_user.deleted", "success", id),
      );
      if (!deleted) throw userNotFound();
    },

    async resetPassword(
      actor: Actor,
      poolId: string,
      userId: string,
    ): Promise<string> {
      const pool = await poolOf(db, actor, poolId);
      const temporaryPassword = randomBytes(18).toString("base64url");
      const passwordHash = await hashPassword(temporaryPassword);
      const user = await recorded(
        actor,
        async (tx) => {
          const changed = await updateUser(tx, pool.id, userId, {
            passwordHash,
            failedLogins: 0,
            lockedUntil: null,
          });
          if (changed) await revokeUserSessions(tx, changed.id);
          return changed;
        },
        (saved) =>
          auditEvent(actor, "pool_user.password_reset", "success", saved.id),
      );
      if (!user) throw userNotFound();
      return temporaryPassword;
    },

    async changePassword(
      actor: Actor,
      poolId: string,
      userId: string,
      currentPassword: string,
      newPassword: string,
    ): Promise<void> {
      const pool = await poolOf(db, actor, poolId);
      const user = await findUser(db, pool.id, userId);
      if (!user) throw userNotFound();
      if (!(await verifyPassword(user.passwordHash, currentPassword)))
        throw new AppError(
          401,
          "UNAUTHORIZED",
          "The current password is wrong",
        );
      checkPassword(newPassword, pool.minPasswordLength);
      const passwordHash = await hashPassword(newPassword);
      await recorded(
        actor,
        async (tx) => {
          const changed = await updateUser(tx, pool.id, user.id, {
            passwordHash,
          });
          await revokeUserSessions(tx, user.id);
          return changed;
        },
        (saved) =>
          auditEvent(actor, "pool_user.password_changed", "success", saved.id),
      );
    },
  };
}

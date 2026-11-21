import { AppError } from "../errors.js";
import {
  addUserRole,
  countRoles,
  countUserRoles,
  deleteRole,
  findRole,
  findUser,
  insertRole,
  listRoles,
  removeUserRole,
  updateRole,
  userRoles,
} from "../models/identity.model.js";
import {
  auditEvent,
  poolOf,
  recorder,
  roleNotFound,
  userNotFound,
  type Actor,
  type IdentityDeps,
} from "./context.js";
import type { UserService } from "./user.service.js";

export const MAX_ROLES_PER_POOL = 50;
export const MAX_ROLES_PER_USER = 20;

export type RoleService = ReturnType<typeof createRoleService>;

export function createRoleService(deps: IdentityDeps, users: UserService) {
  const { db } = deps;
  const recorded = recorder(deps);

  async function found(actor: Actor, poolId: string, role: string) {
    const pool = await poolOf(db, actor, poolId);
    const row = await findRole(db, pool.id, role);
    if (!row) throw roleNotFound();
    return row;
  }

  async function userAndRole(
    actor: Actor,
    poolId: string,
    userId: string,
    roleName: string,
  ) {
    const pool = await poolOf(db, actor, poolId);
    const user = await findUser(db, pool.id, userId);
    if (!user) throw userNotFound();
    const role = await findRole(db, pool.id, roleName);
    if (!role) throw roleNotFound();
    return { user, role };
  }

  return {
    async list(actor: Actor, poolId: string) {
      const pool = await poolOf(db, actor, poolId);
      return listRoles(db, pool.id);
    },

    async create(
      actor: Actor,
      poolId: string,
      input: { name: string; description?: string; permissions: string[] },
    ) {
      const pool = await poolOf(db, actor, poolId);
      if ((await countRoles(db, pool.id)) >= MAX_ROLES_PER_POOL)
        throw new AppError(
          409,
          "CONFLICT",
          `A user pool can have at most ${MAX_ROLES_PER_POOL} roles`,
        );
      const role = await recorded(
        actor,
        (tx) =>
          insertRole(tx, {
            poolId: pool.id,
            name: input.name,
            description: input.description ?? "",
            permissions: input.permissions,
          }),
        (saved) => auditEvent(actor, "pool_role.created", "success", saved.id),
      );
      if (!role)
        throw new AppError(
          409,
          "CONFLICT",
          "A role with this name already exists",
        );
      return { ...role, userCount: 0 };
    },

    get: (actor: Actor, poolId: string, role: string) =>
      found(actor, poolId, role),

    async update(
      actor: Actor,
      poolId: string,
      roleName: string,
      changes: { description?: string; permissions?: string[] },
    ) {
      const pool = await poolOf(db, actor, poolId);
      const role = await recorded(
        actor,
        (tx) => updateRole(tx, pool.id, roleName, changes),
        (saved) => auditEvent(actor, "pool_role.updated", "success", saved.id),
      );
      if (!role) throw roleNotFound();
      return (await findRole(db, pool.id, role.name))!;
    },

    async remove(actor: Actor, poolId: string, roleName: string) {
      const pool = await poolOf(db, actor, poolId);
      const deleted = await recorded(
        actor,
        (tx) => deleteRole(tx, pool.id, roleName),
        (role) => auditEvent(actor, "pool_role.deleted", "success", role.id),
      );
      if (!deleted) throw roleNotFound();
    },

    async addToUser(
      actor: Actor,
      poolId: string,
      userId: string,
      roleName: string,
    ) {
      const { user, role } = await userAndRole(actor, poolId, userId, roleName);
      if ((await countUserRoles(db, user.id)) >= MAX_ROLES_PER_USER) {
        const has = (await userRoles(db, user.id)).some(
          (r) => r.name === role.name,
        );
        if (!has)
          throw new AppError(
            409,
            "CONFLICT",
            `A user can have at most ${MAX_ROLES_PER_USER} roles`,
          );
      }
      await recorded(
        actor,
        async (tx) =>
          (await addUserRole(tx, user.id, role.id)) ? user.id : undefined,
        (id) => auditEvent(actor, "pool_user.role_added", "success", id),
      );
      return users.withRoles(user);
    },

    async removeFromUser(
      actor: Actor,
      poolId: string,
      userId: string,
      roleName: string,
    ) {
      const { user, role } = await userAndRole(actor, poolId, userId, roleName);
      await recorded(
        actor,
        async (tx) =>
          (await removeUserRole(tx, user.id, role.id)) ? user.id : undefined,
        (id) => auditEvent(actor, "pool_user.role_removed", "success", id),
      );
      return users.withRoles(user);
    },
  };
}

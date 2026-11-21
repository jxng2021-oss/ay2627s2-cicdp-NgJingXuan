import { randomUUID } from "node:crypto";
import { AppError } from "../errors.js";
import {
  deletePool,
  deleteTenantPools,
  insertPool,
  listPools,
  publicKeys,
  updatePool,
} from "../models/identity.model.js";
import { MIN_PASSWORD_LENGTH } from "../passwords.js";
import type { NewPoolBody, PoolChangesBody } from "../schemas.js";
import { newSigningKey } from "../signing.js";
import {
  auditEvent,
  isUniqueViolation,
  poolNotFound,
  poolOf,
  recorder,
  type Actor,
  type IdentityDeps,
} from "./context.js";

const DEFAULT_ACCESS_TTL = 15 * 60;
const DEFAULT_REFRESH_TTL = 30 * 86_400;

const nameTaken = () =>
  new AppError(409, "CONFLICT", "A user pool with this name already exists");

export type PoolService = ReturnType<typeof createPoolService>;

export function createPoolService(deps: IdentityDeps) {
  const { db, keyVault } = deps;
  const recorded = recorder(deps);

  return {
    list: (actor: Actor) => listPools(db, actor.tenantId),

    get: (actor: Actor, poolId: string) => poolOf(db, actor, poolId),

    async create(actor: Actor, body: NewPoolBody) {
      const poolId = randomUUID();
      const key = newSigningKey(actor.tenantId, poolId);
      let wrapped: Buffer;
      try {
        wrapped = await keyVault.wrap(
          actor.tenantId,
          poolId,
          key.dataKey,
          actor.requestId,
        );
      } finally {
        key.dataKey.fill(0);
      }
      try {
        const pool = await recorded(
          actor,
          (tx) =>
            insertPool(
              tx,
              {
                id: poolId,
                tenantId: actor.tenantId,
                name: body.name,
                accessTokenTtlSeconds:
                  body.accessTokenTtlSeconds ?? DEFAULT_ACCESS_TTL,
                refreshTokenTtlSeconds:
                  body.refreshTokenTtlSeconds ?? DEFAULT_REFRESH_TTL,
                minPasswordLength:
                  body.minPasswordLength ?? MIN_PASSWORD_LENGTH,
              },
              {
                id: key.kid,
                poolId,
                publicJwk: key.publicJwk,
                ...key.encrypted,
                wrappedDataKey: wrapped,
              },
            ),
          (saved) =>
            auditEvent(actor, "user_pool.created", "success", saved.id),
        );
        return { ...pool!, userCount: 0 };
      } catch (error) {
        if (isUniqueViolation(error)) throw nameTaken();
        throw error;
      }
    },

    async update(actor: Actor, poolId: string, changes: PoolChangesBody) {
      try {
        const changed = await recorded(
          actor,
          async (tx) =>
            (await updatePool(tx, actor.tenantId, poolId, changes))
              ? poolId
              : undefined,
          (id) => auditEvent(actor, "user_pool.updated", "success", id),
        );
        if (!changed) throw poolNotFound();
      } catch (error) {
        if (isUniqueViolation(error)) throw nameTaken();
        throw error;
      }
      return poolOf(db, actor, poolId);
    },

    async remove(actor: Actor, poolId: string): Promise<void> {
      const deleted = await recorded(
        actor,
        async (tx) =>
          (await deletePool(tx, actor.tenantId, poolId)) ? poolId : undefined,
        (id) => auditEvent(actor, "user_pool.deleted", "success", id),
      );
      if (!deleted) throw poolNotFound();
    },

    async jwks(poolId: string) {
      const keys = await publicKeys(db, poolId);
      if (!keys) throw poolNotFound();
      return keys;
    },

    removeTenant: (actor: Actor) => deleteTenantPools(db, actor.tenantId),
  };
}

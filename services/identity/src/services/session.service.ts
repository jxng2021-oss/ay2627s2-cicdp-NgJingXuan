import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolUser } from "../db/schema.js";
import { AppError } from "../errors.js";
import {
  findSessionByRefresh,
  findSigningKey,
  findUser,
  findUserByEmail,
  insertSession,
  recordFailedLogin,
  recordLogin,
  revokeSession,
  rotateSession,
  userRoles,
} from "../models/identity.model.js";
import { verifyAgainstDummy, verifyPassword } from "../passwords.js";
import { openSigningKey, signJwt } from "../signing.js";
import {
  auditEvent,
  normalizeEmail,
  poolOf,
  type Actor,
  type IdentityDeps,
} from "./context.js";

export const LOCK_AFTER = 5;
export const LOCK_MS = 15 * 60_000;

const wrongLogin = () =>
  new AppError(401, "UNAUTHORIZED", "Wrong email or password");
const badRefresh = () =>
  new AppError(
    401,
    "UNAUTHORIZED",
    "The refresh token is invalid or has expired",
  );

const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

export function issuerOf(publicBaseUrl: string, poolId: string): string {
  return `${publicBaseUrl}/v1/user-pools/${poolId}`;
}

export type SessionService = ReturnType<typeof createSessionService>;

export function createSessionService(deps: IdentityDeps) {
  const { db, audit, keyVault, publicBaseUrl, now } = deps;

  async function issueTokens(
    actor: Actor,
    pool: Pool,
    user: PoolUser,
    sessionId?: string,
  ) {
    const key = await findSigningKey(db, pool.id);
    if (!key) throw new Error("the pool has no signing key");
    const roles = await userRoles(db, user.id);
    const dataKey = await keyVault.unwrap(
      pool.tenantId,
      pool.id,
      key.wrappedDataKey,
      actor.requestId,
    );
    let accessToken: string;
    try {
      const privateKey = openSigningKey(
        pool.tenantId,
        pool.id,
        key.id,
        key,
        dataKey,
      );
      const issuedAt = Math.floor(now() / 1000);
      accessToken = signJwt(privateKey, key.id, {
        roles: roles.map((role) => role.name),
        permissions: [
          ...new Set(roles.flatMap((role) => role.permissions)),
        ].sort(),
        iss: issuerOf(publicBaseUrl, pool.id),
        sub: user.id,
        aud: pool.id,
        iat: issuedAt,
        exp: issuedAt + pool.accessTokenTtlSeconds,
        jti: randomUUID(),
        token_use: "access",
        email: user.email,
        attributes: user.attributes,
      });
    } finally {
      dataKey.fill(0);
    }

    const refreshToken = randomBytes(32).toString("base64url");
    if (!sessionId) {
      await insertSession(db, {
        poolId: pool.id,
        userId: user.id,
        refreshHash: hashToken(refreshToken),
        expiresAt: new Date(now() + pool.refreshTokenTtlSeconds * 1000),
      });
    }
    return {
      accessToken,
      tokenType: "Bearer" as const,
      expiresIn: pool.accessTokenTtlSeconds,
      refreshToken,
      user,
      roles: roles.map((role) => role.name),
    };
  }

  const bestEffort = (
    actor: Actor,
    action: string,
    outcome: "success" | "denied",
    poolId: string,
    resourceId?: string,
  ) =>
    void audit.recordBestEffort(
      auditEvent(actor, action, outcome, resourceId, poolId),
      actor.log,
    );

  return {
    async login(actor: Actor, poolId: string, email: string, password: string) {
      const pool = await poolOf(db, actor, poolId);
      const user = await findUserByEmail(db, pool.id, normalizeEmail(email));
      const failed = (resourceId?: string) => {
        bestEffort(
          actor,
          "pool_user.login_failed",
          "denied",
          pool.id,
          resourceId,
        );
        return wrongLogin();
      };
      if (!user) {
        await verifyAgainstDummy(password);
        throw failed();
      }
      const locked =
        user.lockedUntil !== null && user.lockedUntil.getTime() > now();
      const passwordOk = await verifyPassword(user.passwordHash, password);
      if (locked || user.status !== "active" || !passwordOk) {
        if (!passwordOk && !locked) {
          await recordFailedLogin(
            db,
            user.id,
            LOCK_AFTER,
            new Date(now() + LOCK_MS),
          );
        }
        throw failed(user.id);
      }
      const tokens = await issueTokens(actor, pool, user);
      await recordLogin(db, user.id);
      bestEffort(actor, "pool_user.logged_in", "success", pool.id, user.id);
      return tokens;
    },

    async refresh(actor: Actor, poolId: string, refreshToken: string) {
      const pool = await poolOf(db, actor, poolId);
      const hash = hashToken(refreshToken);
      const found = await findSessionByRefresh(db, pool.id, hash);
      if (!found) throw badRefresh();
      const { session } = found;
      if (found.used && !session.revoked) {
        await revokeSession(db, session.id);
        actor.log.warn(
          { sessionId: session.id },
          "a replaced refresh token was used again; the session was revoked",
        );
        bestEffort(
          actor,
          "pool_user.token_reused",
          "denied",
          pool.id,
          session.userId,
        );
        throw badRefresh();
      }
      if (session.revoked || found.used || session.expiresAt.getTime() <= now())
        throw badRefresh();
      const user = await findUser(db, pool.id, session.userId);
      if (!user || user.status !== "active") throw badRefresh();
      const tokens = await issueTokens(actor, pool, user, session.id);
      const rotated = await db.transaction((tx) =>
        rotateSession(tx, session.id, hash, hashToken(tokens.refreshToken)),
      );
      if (!rotated) {
        await revokeSession(db, session.id);
        throw badRefresh();
      }
      return tokens;
    },

    async revoke(
      actor: Actor,
      poolId: string,
      refreshToken: string,
    ): Promise<void> {
      const pool = await poolOf(db, actor, poolId);
      const found = await findSessionByRefresh(
        db,
        pool.id,
        hashToken(refreshToken),
      );
      const session = found?.session;
      if (session && !session.revoked) {
        await revokeSession(db, session.id);
        bestEffort(
          actor,
          "pool_user.logged_out",
          "success",
          pool.id,
          session.userId,
        );
      }
    },
  };
}

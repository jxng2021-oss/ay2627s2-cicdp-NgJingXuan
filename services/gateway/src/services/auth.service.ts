import type { FastifyRequest } from "fastify";
import type { AuditClient, AuditEvent } from "../audit.js";
import type { Database } from "../db/client.js";
import { createTenant } from "../models/platform.model.js";
import type { User } from "../db/schema.js";
import {
  insertMembership,
  listMemberships,
  type WorkspaceMembership,
} from "../models/membership.model.js";
import { findOAuthUserId, insertOAuthIdentity } from "../models/oauth.model.js";
import { revokeUserSessions } from "../models/session.model.js";
import {
  findUserByEmail,
  findUserById,
  insertUser,
  updatePasswordHash,
} from "../models/user.model.js";
import {
  displayNameFrom,
  type OAuthProfile,
  type OAuthProviderId,
} from "./oauth.service.js";
import {
  hashPassword,
  passwordProblem,
  verifyAgainstDummy,
  verifyPassword,
} from "./password.service.js";

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class PasswordPolicyError extends Error {}
export class EmailTakenError extends Error {}

export function userEvent(
  request: FastifyRequest | undefined,
  action: string,
  userId: string | undefined,
  tenantId: string | undefined,
  outcome: AuditEvent["outcome"] = "success",
): AuditEvent {
  return {
    action,
    outcome,
    actorType: "user",
    actorId: userId,
    tenantId,
    resourceId: userId,
    requestId: request?.id,
    sourceIp: request?.ip,
  };
}

export async function recordInWorkspaces(
  db: Database,
  audit: AuditClient,
  request: FastifyRequest,
  action: string,
  userId: string,
  outcome: AuditEvent["outcome"] = "success",
): Promise<void> {
  const workspaces = await listMemberships(db, userId);
  for (const workspace of workspaces) {
    void audit.recordBestEffort(
      userEvent(request, action, userId, workspace.tenantId, outcome),
      request.log,
    );
  }
}

export async function signUp(
  db: Database,
  audit: AuditClient,
  request: FastifyRequest,
  input: { email: string; password: string; workspaceName: string },
): Promise<{ user: User; workspace: WorkspaceMembership }> {
  const problem = passwordProblem(input.password);
  if (problem) throw new PasswordPolicyError(problem);
  const passwordHash = await hashPassword(input.password);

  return db.transaction(async (tx) => {
    const user = await insertUser(tx, {
      email: normaliseEmail(input.email),
      passwordHash,
    });
    if (!user) throw new EmailTakenError();
    const tenant = await createTenant(tx, input.workspaceName);
    await insertMembership(tx, {
      userId: user.id,
      tenantId: tenant.id,
      role: "owner",
    });
    await audit.record(
      userEvent(request, "user.signed_up", user.id, tenant.id),
      request.log,
    );
    return {
      user,
      workspace: {
        tenantId: tenant.id,
        name: tenant.name,
        status: tenant.status,
        role: "owner",
      },
    };
  });
}

export async function checkLogin(
  db: Database,
  audit: AuditClient,
  request: FastifyRequest,
  email: string,
  password: string,
): Promise<User | undefined> {
  const user = await findUserByEmail(db, normaliseEmail(email));
  if (!user) {
    await verifyAgainstDummy(password);
    void audit.recordBestEffort(
      userEvent(request, "user.login_failed", undefined, undefined, "failure"),
      request.log,
    );
    return undefined;
  }
  const ok = user.passwordHash
    ? await verifyPassword(user.passwordHash, password)
    : await verifyAgainstDummy(password);
  if (!ok || user.status !== "active") {
    await recordInWorkspaces(
      db,
      audit,
      request,
      "user.login_failed",
      user.id,
      "failure",
    );
    return undefined;
  }
  return user;
}

export class OAuthAccountError extends Error {}

export async function signInWithOAuth(
  db: Database,
  audit: AuditClient,
  request: FastifyRequest,
  provider: OAuthProviderId,
  profile: OAuthProfile,
): Promise<User | undefined> {
  const linkedId = await findOAuthUserId(db, provider, profile.subject);
  const user = linkedId
    ? await findUserById(db, linkedId)
    : await linkOrCreate(db, audit, request, provider, profile);
  return user?.status === "active" ? user : undefined;
}

async function linkOrCreate(
  db: Database,
  audit: AuditClient,
  request: FastifyRequest,
  provider: OAuthProviderId,
  profile: OAuthProfile,
): Promise<User | undefined> {
  const email = normaliseEmail(profile.email);
  const existing = await findUserByEmail(db, email);
  if (existing) {
    await insertOAuthIdentity(db, {
      provider,
      subject: profile.subject,
      userId: existing.id,
    });
    void audit.recordBestEffort(
      userEvent(request, "user.oauth_linked", existing.id, undefined),
      request.log,
    );
    return existing;
  }
  return db.transaction(async (tx) => {
    const created = await insertUser(tx, {
      email,
      passwordHash: null,
      displayName: displayNameFrom(profile.name),
    });
    if (!created) throw new OAuthAccountError();
    await insertOAuthIdentity(tx, {
      provider,
      subject: profile.subject,
      userId: created.id,
    });
    return created;
  });
}

export async function setPassword(
  db: Database,
  audit: AuditClient,
  request: FastifyRequest | undefined,
  log: FastifyRequest["log"],
  user: Pick<User, "id">,
  newPassword: string,
  keepSessionId?: string,
): Promise<void> {
  const problem = passwordProblem(newPassword);
  if (problem) throw new PasswordPolicyError(problem);
  const passwordHash = await hashPassword(newPassword);
  await db.transaction(async (tx) => {
    await updatePasswordHash(tx, user.id, passwordHash);
    await revokeUserSessions(tx, user.id, keepSessionId);
    for (const workspace of await listMemberships(tx, user.id)) {
      await audit.record(
        userEvent(
          request,
          "user.password_changed",
          user.id,
          workspace.tenantId,
        ),
        log,
      );
    }
  });
}

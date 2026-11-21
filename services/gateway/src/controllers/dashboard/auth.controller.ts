import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { sendError } from "../../errors.js";
import { rateLimited, serviceUnavailable } from "../../limits.js";
import { accountService } from "../../services/account.service.js";
import {
  checkLogin,
  EmailTakenError,
  normaliseEmail,
  PasswordPolicyError,
  recordInWorkspaces,
  setPassword,
  signUp,
  userEvent,
} from "../../services/auth.service.js";
import { verifyPassword } from "../../services/password.service.js";
import {
  clearSessionCookie,
  csrfTokenFor,
  startSession,
} from "../../services/session.service.js";
import type { DashboardOptions } from "../../routes/dashboard/index.js";

type Body<T> = FastifyRequest<{ Body: T }>;

export const MAX_OWNED_WORKSPACES = 20;

const origin = (request: FastifyRequest) => ({
  ip: request.ip,
  userAgent: request.headers["user-agent"],
});

export function authController(options: DashboardOptions) {
  const { db, audit, dashboard, limiters } = options;
  const settings = dashboard.session;
  const account = accountService(db, audit);

  async function limited(
    request: FastifyRequest,
    reply: FastifyReply,
    email?: string,
  ): Promise<FastifyReply | undefined> {
    try {
      const byIp = await limiters.authPerIp.consume(request.ip);
      if (!byIp.allowed) return rateLimited(reply, byIp.resetSeconds);
      if (email !== undefined) {
        const key = createHash("sha256")
          .update(normaliseEmail(email))
          .digest("hex");
        const byEmail = await limiters.authPerEmail.consume(key);
        if (!byEmail.allowed) return rateLimited(reply, byEmail.resetSeconds);
      }
      return undefined;
    } catch (error) {
      options.warnRateLimitingDown(request.log, error);
      return serviceUnavailable(
        reply,
        "Sign-in is temporarily unavailable, try again later",
      );
    }
  }

  async function me(userId: string) {
    const { user, workspaces } = await account.profile(userId);
    return {
      user: {
        id: userId,
        email: user?.email ?? "",
        displayName: user?.displayName ?? null,
        createdAt: user?.createdAt.toISOString() ?? new Date(0).toISOString(),
      },
      workspaces: workspaces.map((w) => ({
        id: w.tenantId,
        name: w.name,
        role: w.role,
      })),
    };
  }

  return {
    signUp: async (
      request: Body<{ email: string; password: string; workspaceName: string }>,
      reply: FastifyReply,
    ) => {
      const refused = await limited(request, reply, request.body.email);
      if (refused) return refused;
      try {
        const { user } = await signUp(db, audit, request, request.body);
        await startSession(db, settings, reply, user.id, origin(request));
        return reply.code(201).send(await me(user.id));
      } catch (error) {
        if (error instanceof PasswordPolicyError) {
          return sendError(reply, 400, "BAD_REQUEST", error.message);
        }
        if (error instanceof EmailTakenError) {
          return sendError(
            reply,
            409,
            "CONFLICT",
            "An account with this email already exists",
          );
        }
        throw error;
      }
    },

    login: async (
      request: Body<{ email: string; password: string }>,
      reply: FastifyReply,
    ) => {
      const refused = await limited(request, reply, request.body.email);
      if (refused) return refused;
      const user = await checkLogin(
        db,
        audit,
        request,
        request.body.email,
        request.body.password,
      );
      if (!user) {
        return sendError(reply, 401, "UNAUTHORIZED", "Wrong email or password");
      }
      await startSession(db, settings, reply, user.id, origin(request));
      await recordInWorkspaces(db, audit, request, "user.logged_in", user.id);
      return me(user.id);
    },

    logout: async (request: FastifyRequest, reply: FastifyReply) => {
      const session = request.dashboardSession!;
      await account.endSession(session.session.id);
      await recordInWorkspaces(
        db,
        audit,
        request,
        "user.logged_out",
        session.user.id,
      );
      clearSessionCookie(reply, settings);
      return reply.code(204).send();
    },

    logoutAll: async (request: FastifyRequest, reply: FastifyReply) => {
      const session = request.dashboardSession!;
      await account.endAllSessions(session.user.id);
      await recordInWorkspaces(
        db,
        audit,
        request,
        "user.logged_out",
        session.user.id,
      );
      clearSessionCookie(reply, settings);
      return reply.code(204).send();
    },

    me: (request: FastifyRequest) => {
      return me(request.dashboardSession!.user.id);
    },

    csrf: (request: FastifyRequest) => {
      return {
        csrfToken: csrfTokenFor(settings, request.dashboardSession!.session.id),
      };
    },

    changePassword: async (
      request: Body<{ currentPassword: string; newPassword: string }>,
      reply: FastifyReply,
    ) => {
      const session = request.dashboardSession!;
      const refused = await limited(request, reply, session.user.email);
      if (refused) return refused;
      if (
        !(await verifyPassword(
          session.user.passwordHash,
          request.body.currentPassword,
        ))
      ) {
        return sendError(
          reply,
          401,
          "UNAUTHORIZED",
          "The current password is wrong",
        );
      }
      try {
        await setPassword(
          db,
          audit,
          request,
          request.log,
          session.user,
          request.body.newPassword,
          session.session.id,
        );
      } catch (error) {
        if (error instanceof PasswordPolicyError) {
          return sendError(reply, 400, "BAD_REQUEST", error.message);
        }
        throw error;
      }
      return reply.code(204).send();
    },

    updateProfile: async (request: Body<{ displayName: string | null }>) => {
      const userId = request.dashboardSession!.user.id;
      const name = request.body.displayName?.trim() || null;
      await account.setDisplayName(userId, name);
      await recordInWorkspaces(
        db,
        audit,
        request,
        "user.profile_updated",
        userId,
      );
      return me(userId);
    },

    sessions: async (request: FastifyRequest) => {
      const { user, session: current } = request.dashboardSession!;
      const sessions = await account.listSessions(
        user.id,
        settings.idleTimeoutMs,
      );
      return {
        sessions: sessions.map((s) => ({
          id: s.id,
          createdAt: s.createdAt.toISOString(),
          lastUsedAt: s.lastUsedAt.toISOString(),
          expiresAt: s.expiresAt.toISOString(),
          ip: s.ip,
          userAgent: s.userAgent,
          current: s.id === current.id,
        })),
      };
    },

    revokeSession: async (
      request: FastifyRequest<{ Params: { sessionId: string } }>,
      reply: FastifyReply,
    ) => {
      const { user, session: current } = request.dashboardSession!;
      const { sessionId } = request.params;
      if (!(await account.endUserSession(user.id, sessionId))) {
        return sendError(reply, 404, "NOT_FOUND", "Session not found");
      }
      await recordInWorkspaces(
        db,
        audit,
        request,
        "user.session_revoked",
        user.id,
      );
      if (sessionId === current.id) clearSessionCookie(reply, settings);
      return reply.code(204).send();
    },

    deleteAccount: async (
      request: Body<{ password: string }>,
      reply: FastifyReply,
    ) => {
      const { user } = request.dashboardSession!;
      const refused = await limited(request, reply, user.email);
      if (refused) return refused;
      if (!(await verifyPassword(user.passwordHash, request.body.password))) {
        return sendError(reply, 401, "UNAUTHORIZED", "The password is wrong");
      }
      const sole = await account.soleOwnedWorkspace(user.id);
      if (sole) {
        return sendError(
          reply,
          409,
          "CONFLICT",
          `You are the only owner of ${sole.name}: delete it, or make someone else an owner, first`,
        );
      }
      await account.deleteAccount(
        user.id,
        (tenantId) => userEvent(request, "user.deleted", user.id, tenantId),
        request.log,
      );
      clearSessionCookie(reply, settings);
      return reply.code(204).send();
    },

    createWorkspace: async (
      request: Body<{ name: string }>,
      reply: FastifyReply,
    ) => {
      const { user } = request.dashboardSession!;
      if (
        (await account.ownedWorkspaceCount(user.id)) >= MAX_OWNED_WORKSPACES
      ) {
        return sendError(
          reply,
          409,
          "CONFLICT",
          `You can own at most ${MAX_OWNED_WORKSPACES} workspaces`,
        );
      }
      const name = request.body.name.trim();
      if (name === "") {
        return sendError(reply, 400, "BAD_REQUEST", "The name can't be blank");
      }
      const tenant = await account.createWorkspace(
        user.id,
        name,
        (tenantId) => ({
          ...userEvent(request, "tenant.created", user.id, tenantId),
          resourceId: tenantId,
        }),
        request.log,
      );
      return reply
        .code(201)
        .send({ id: tenant.id, name: tenant.name, role: "owner" as const });
    },
  };
}

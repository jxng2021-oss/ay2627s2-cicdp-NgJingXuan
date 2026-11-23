import type {
  FastifyBaseLogger,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { AuditClient } from "../../audit.js";
import type { Database } from "../../db/client.js";
import { sendError } from "../../errors.js";
import type { HttpFetch, OAuthSettings } from "../../services/oauth.service.js";
import type { ProxyPolicy } from "../../services/ssrf.service.js";
import type { RateLimiter, RateLimitStore } from "../../rate-limit.js";
import type { WorkspaceMembership } from "../../models/membership.model.js";
import {
  csrfTokenMatches,
  currentSession,
  type ActiveSession,
  type SessionSettings,
} from "../../services/session.service.js";
import { accountRoutes } from "./account.routes.js";
import { authRoutes } from "./auth.routes.js";
import { workspaceRoutes } from "./workspace.routes.js";

export interface DashboardSettings {
  origin: string;
  session: SessionSettings;
  authLimits: { perIp: number; perEmail: number };
  oauth: OAuthSettings;
}

export interface DashboardOptions {
  db: Database;
  audit: AuditClient;
  dashboard: DashboardSettings;
  oauthFetch: HttpFetch;
  limiters: { authPerIp: RateLimiter; authPerEmail: RateLimiter };
  warnRateLimitingDown: (log: FastifyBaseLogger, error: unknown) => void;
  apiKeyPrefix: string;
  apiKeyHashSecret: string;
  storageUrl: string;
  secretsUrl: string;
  auditUrl: string;
  auditToken: string;
  identityUrl: string;
  flagsUrl: string;
  connectTimeoutMs: number;
  responseTimeoutMs: number;
  maxUploadBytes: number;
  maxSecretBytes: number;
  proxy: ProxyPolicy;
  rateLimitStore: RateLimitStore;
}

declare module "fastify" {
  interface FastifyRequest {
    dashboardSession: ActiveSession | undefined;
    dashboardUserId: string | undefined;
    dashboardWorkspace: WorkspaceMembership | undefined;
  }
  interface FastifyContextConfig {
    dashboardPublic?: boolean;
    ownerOnly?: boolean;
    whileDeleting?: boolean;
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const dashboardApi: FastifyPluginCallback<DashboardOptions> = (
  app,
  options,
  done,
) => {
  const { db, dashboard } = options;
  app.decorateRequest("tenantId", "");
  app.decorateRequest("apiKeyId", "");
  app.decorateRequest("dashboardSession", undefined);
  app.decorateRequest("dashboardUserId", undefined);
  app.decorateRequest("dashboardWorkspace", undefined);

  app.addHook("onRequest", async (request, reply) => {
    securityHeaders(reply, dashboard.session.cookieSecure);
    const origin = request.headers.origin;
    const fromDashboard = origin === dashboard.origin;
    if (fromDashboard) {
      reply.header("access-control-allow-origin", dashboard.origin);
      reply.header("access-control-allow-credentials", "true");
      reply.header(
        "access-control-expose-headers",
        "x-request-id, retry-after",
      );
    }
    reply.header("vary", "Origin");
    if (request.method === "OPTIONS") return;

    const changesData = !SAFE_METHODS.has(request.method);
    if (changesData && !fromDashboard) {
      return sendError(
        reply,
        403,
        "FORBIDDEN",
        "Requests that change data must come from the dashboard (Origin)",
      );
    }
    if (request.routeOptions.config.dashboardPublic) return;

    const session = await currentSession(db, dashboard.session, request, reply);
    if (!session) {
      return sendError(reply, 401, "UNAUTHORIZED", "Sign in first");
    }
    if (
      changesData &&
      !csrfTokenMatches(
        dashboard.session,
        session.session.id,
        request.headers["x-csrf-token"],
      )
    ) {
      return sendError(
        reply,
        403,
        "FORBIDDEN",
        "A valid CSRF token is required (X-CSRF-Token)",
      );
    }
    request.dashboardSession = session;
    request.dashboardUserId = session.user.id;
  });

  app.options("/*", { config: { dashboardPublic: true } }, (request, reply) =>
    preflight(request, reply, dashboard.origin),
  );

  app.register(authRoutes, { ...options, prefix: "/auth" });
  app.register(accountRoutes, { ...options, prefix: "" });
  app.register(workspaceRoutes, {
    ...options,
    prefix: "/workspaces/:workspaceId",
  });
  done();
};

function preflight(
  request: FastifyRequest,
  reply: FastifyReply,
  origin: string,
) {
  if (request.headers.origin !== origin) {
    return sendError(reply, 403, "FORBIDDEN", "Origin not allowed");
  }
  return reply
    .code(204)
    .header("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE")
    .header(
      "access-control-allow-headers",
      "content-type, x-csrf-token, x-file-name",
    )
    .header("access-control-max-age", "600")
    .send();
}

function securityHeaders(reply: FastifyReply, https: boolean): void {
  reply.header("cache-control", "no-store");
  reply.header("x-content-type-options", "nosniff");
  reply.header("x-frame-options", "DENY");
  reply.header("referrer-policy", "no-referrer");
  reply.header(
    "content-security-policy",
    "default-src 'none'; frame-ancestors 'none'",
  );
  reply.header("cross-origin-opener-policy", "same-origin");
  reply.header("cross-origin-resource-policy", "same-site");
  if (https) {
    reply.header("strict-transport-security", "max-age=31536000");
  }
}

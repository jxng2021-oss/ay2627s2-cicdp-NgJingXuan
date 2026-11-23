import type { FastifyReply, FastifyRequest } from "fastify";
import { serviceUnavailable } from "../../limits.js";
import {
  recordInWorkspaces,
  signInWithOAuth,
} from "../../services/auth.service.js";
import {
  enabledProviders,
  fetchProfile,
  OAuthError,
  STATE_TTL_SECONDS,
  startAuthorization,
  stateMatches,
  type OAuthProviderId,
} from "../../services/oauth.service.js";
import {
  readOAuthStateCookie,
  setOAuthStateCookie,
  startSession,
} from "../../services/session.service.js";
import type { DashboardOptions } from "../../routes/dashboard/index.js";

type Provider = { Params: { provider: OAuthProviderId } };
type Callback = Provider & {
  Querystring: { code?: string; state?: string; error?: string };
};

export function oauthController(options: DashboardOptions) {
  const { db, audit, dashboard, limiters } = options;
  const settings = dashboard.session;
  const oauth = dashboard.oauth;

  const backToLogin = (reply: FastifyReply, reason: string) =>
    reply.redirect(
      `${dashboard.origin}/login?oauth_error=${encodeURIComponent(reason)}`,
      302,
    );

  async function allowed(request: FastifyRequest, reply: FastifyReply) {
    try {
      const byIp = await limiters.authPerIp.consume(request.ip);
      return byIp.allowed;
    } catch (error) {
      options.warnRateLimitingDown(request.log, error);
      serviceUnavailable(
        reply,
        "Sign-in is temporarily unavailable, try again later",
      );
      return undefined;
    }
  }

  return {
    providers: () => ({ providers: enabledProviders(oauth) }),

    start: async (request: FastifyRequest<Provider>, reply: FastifyReply) => {
      const { provider } = request.params;
      if (!oauth[provider]) return backToLogin(reply, "unavailable");
      const ok = await allowed(request, reply);
      if (ok === undefined) return reply;
      if (!ok) return backToLogin(reply, "rate_limited");
      const { url, stateCookie } = startAuthorization(
        oauth,
        settings.secret,
        provider,
      );
      setOAuthStateCookie(reply, settings, stateCookie, STATE_TTL_SECONDS);
      return reply.redirect(url, 302);
    },

    callback: async (
      request: FastifyRequest<Callback>,
      reply: FastifyReply,
    ) => {
      const { provider } = request.params;
      const { code, state, error } = request.query;
      const cookie = readOAuthStateCookie(request, settings);
      setOAuthStateCookie(reply, settings, "", 0);
      if (!oauth[provider]) return backToLogin(reply, "unavailable");
      if (error) return backToLogin(reply, "cancelled");
      if (!code || !stateMatches(settings.secret, provider, cookie, state)) {
        return backToLogin(reply, "failed");
      }
      const ok = await allowed(request, reply);
      if (ok === undefined) return reply;
      if (!ok) return backToLogin(reply, "rate_limited");

      let profile;
      try {
        profile = await fetchProfile(
          oauth,
          settings.secret,
          provider,
          code,
          state!,
          options.oauthFetch,
        );
      } catch (failure) {
        if (failure instanceof OAuthError) {
          return backToLogin(reply, failure.reason);
        }
        request.log.warn(
          { provider, reason: (failure as Error).name },
          "couldn't reach the sign in provider",
        );
        return backToLogin(reply, "failed");
      }

      const user = await signInWithOAuth(db, audit, request, provider, profile);
      if (!user) return backToLogin(reply, "disabled");
      await startSession(db, settings, reply, user.id, {
        ip: request.ip,
        userAgent: request.headers["user-agent"],
      });
      await recordInWorkspaces(db, audit, request, "user.logged_in", user.id);
      return reply.redirect(`${dashboard.origin}/workspaces`, 302);
    },
  };
}

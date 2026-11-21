import type { proxySchema } from "../api/proxy-schemas.js";
import { sendError } from "../errors.js";
import { connectionService } from "../services/connection.service.js";
import {
  clientPath,
  type ProxyRouteOptions,
  type ProxyService,
} from "../services/proxy.service.js";
import {
  BlockedTargetError,
  checkBaseUrl,
  hostOf,
  resolveAndCheck,
  targetUrl,
} from "../services/ssrf.service.js";
import type { Rep, Req } from "../types.js";

export function createProxyController(
  options: ProxyRouteOptions,
  proxy: ProxyService,
) {
  const connections = connectionService(options.db);
  const { enforcePolicy, fetchSecret, forward } = proxy;
  return {
    handle: async (
      request: Req<typeof proxySchema>,
      reply: Rep<typeof proxySchema>,
    ) => {
      const connection = await connections.find(
        request.tenantId,
        request.params.connection,
      );
      if (!connection) {
        return sendError(reply, 404, "NOT_FOUND", "Connection not found");
      }
      request.proxyConnectionName = connection.name;

      let target: URL;
      let pinned: { address: string; family: 4 | 6 };
      try {
        const base = checkBaseUrl(connection.baseUrl, options.policy);
        target = targetUrl(base, clientPath(request.raw.url ?? ""));
        pinned = await resolveAndCheck(
          hostOf(target),
          options.policy,
          options.resolver,
        );
      } catch (error) {
        if (!(error instanceof BlockedTargetError)) throw error;
        request.proxyOutcome = "denied";
        return error.message === "the path isn't allowed"
          ? sendError(reply, 400, "BAD_REQUEST", "That path isn't allowed")
          : sendError(
              reply,
              403,
              "PROXY_TARGET_BLOCKED",
              `The connection's target isn't allowed: ${error.message}`,
            );
      }

      const pass = await enforcePolicy(request, reply, connection);
      if (!pass) return reply;

      const secret = await fetchSecret(request, reply, connection);
      if (secret === undefined) {
        await pass.refund();
        return reply;
      }

      return forward(request, reply, connection, target, pinned, secret, pass);
    },
  };
}

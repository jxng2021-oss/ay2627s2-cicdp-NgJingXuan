import type {
  connectionUsageSchema,
  deleteConnectionSchema,
  listConnectionsSchema,
  putConnectionSchema,
} from "../api/proxy-schemas.js";
import type { ProxyConnection } from "../db/schema.js";
import { sendError } from "../errors.js";
import { serviceUnavailable } from "../limits.js";
import { apiKeyEvent } from "../services/audit-event.service.js";
import {
  checkConnection,
  connectionService,
  connectionUsage,
  type ProxyConnectionOptions,
} from "../services/connection.service.js";
import type { Rep, Req } from "../types.js";

export function toJson(connection: ProxyConnection) {
  return {
    name: connection.name,
    baseUrl: connection.baseUrl,
    secretName: connection.secretName,
    headerName: connection.headerName,
    headerPrefix: connection.headerPrefix,
    policy: connection.policy ?? null,
    createdAt: connection.createdAt.toISOString(),
    updatedAt: connection.updatedAt.toISOString(),
  };
}

export function createProxyConnectionsController(
  options: ProxyConnectionOptions,
) {
  const connections = connectionService(options.db);
  return {
    put: async (
      request: Req<typeof putConnectionSchema>,
      reply: Rep<typeof putConnectionSchema>,
    ) => {
      const checked = checkConnection(request.body, options.policy);
      if ("problem" in checked) {
        return sendError(reply, 400, "BAD_REQUEST", checked.problem);
      }
      const { connection, created } = await connections.save(
        request.tenantId,
        request.params.name,
        checked.settings,
      );
      void options.audit.recordBestEffort(
        apiKeyEvent(
          request,
          created ? "proxy_connection.created" : "proxy_connection.updated",
          connection.name,
        ),
        request.log,
      );
      return reply.code(created ? 201 : 200).send(toJson(connection));
    },

    list: async (request: Req<typeof listConnectionsSchema>) => ({
      connections: (await connections.list(request.tenantId)).map(toJson),
    }),

    usage: async (
      request: Req<typeof connectionUsageSchema>,
      reply: Rep<typeof connectionUsageSchema>,
    ) => {
      const connection = await connections.find(
        request.tenantId,
        request.params.name,
      );
      if (!connection) {
        return sendError(reply, 404, "NOT_FOUND", "Connection not found");
      }
      const usage = await connectionUsage(
        options.rateLimitStore,
        request.tenantId,
        connection,
      );
      if (!usage) {
        return serviceUnavailable(
          reply,
          "The connection's usage counters can't be read right now",
        );
      }
      return usage;
    },

    remove: async (
      request: Req<typeof deleteConnectionSchema>,
      reply: Rep<typeof deleteConnectionSchema>,
    ) => {
      const deleted = await connections.remove(
        request.tenantId,
        request.params.name,
      );
      if (!deleted)
        return sendError(reply, 404, "NOT_FOUND", "Connection not found");
      void options.audit.recordBestEffort(
        apiKeyEvent(request, "proxy_connection.deleted", request.params.name),
        request.log,
      );
      return reply.code(204).send();
    },
  };
}

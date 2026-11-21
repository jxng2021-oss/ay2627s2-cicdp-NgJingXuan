import type { FastifyReply, FastifyRequest } from "fastify";
import type { ConnectionBody } from "../../api/proxy-schemas.js";
import { sendError } from "../../errors.js";
import { serviceUnavailable } from "../../limits.js";
import { toJson } from "../proxy-connections.controller.js";
import {
  checkConnection,
  connectionService,
  connectionUsage,
} from "../../services/connection.service.js";
import type { DashboardOptions } from "../../routes/dashboard/index.js";

export function connectionsController(options: DashboardOptions) {
  const { db, audit } = options;
  const connections = connectionService(db);

  const record = (request: FastifyRequest, action: string, name: string) =>
    void audit.recordBestEffort(
      {
        action,
        outcome: "success",
        actorType: "user",
        actorId: request.dashboardUserId,
        tenantId: request.tenantId,
        resourceId: name,
        requestId: request.id,
        sourceIp: request.ip,
      },
      request.log,
    );

  return {
    list: async (request: FastifyRequest) => {
      return {
        connections: (await connections.list(request.tenantId)).map(toJson),
      };
    },

    put: async (
      request: FastifyRequest<{ Body: ConnectionBody }>,
      reply: FastifyReply,
    ) => {
      const { name } = request.params as { name: string };
      const checked = checkConnection(request.body, options.proxy);
      if ("problem" in checked) {
        return sendError(reply, 400, "BAD_REQUEST", checked.problem);
      }
      const { connection, created } = await connections.save(
        request.tenantId,
        name,
        checked.settings,
      );
      record(
        request,
        created ? "proxy_connection.created" : "proxy_connection.updated",
        connection.name,
      );
      return reply.code(created ? 201 : 200).send(toJson(connection));
    },

    usage: async (request: FastifyRequest, reply: FastifyReply) => {
      const { name } = request.params as { name: string };
      const connection = await connections.find(request.tenantId, name);
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

    remove: async (request: FastifyRequest, reply: FastifyReply) => {
      const { name } = request.params as { name: string };
      if (!(await connections.remove(request.tenantId, name))) {
        return sendError(reply, 404, "NOT_FOUND", "Connection not found");
      }
      record(request, "proxy_connection.deleted", name);
      return reply.code(204).send();
    },
  };
}

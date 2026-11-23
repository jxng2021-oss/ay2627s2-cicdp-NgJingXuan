import type { FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../../errors.js";
import { fetchJson, type Upstream } from "../../services/upstream.service.js";
import { poolPath } from "../../services/user-pools.service.js";

function queryString(request: FastifyRequest): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(
    request.query as Record<string, string | number | undefined>,
  )) {
    if (value !== undefined) search.set(name, String(value));
  }
  return search.size > 0 ? `?${search.toString()}` : "";
}

export function auditController(
  auditService: Upstream,
  auditToken: string,
  identity: Upstream,
) {
  const readEvents = (
    request: FastifyRequest,
    reply: FastifyReply,
    path: string,
  ) =>
    auditService.forward(request, reply, {
      method: "GET",
      path: path + queryString(request),
      headers: {
        authorization: `Bearer ${auditToken}`,
        "x-audit-service": "gateway",
      },
    });

  return {
    list: (request: FastifyRequest, reply: FastifyReply) =>
      readEvents(request, reply, "/events"),

    listPool: async (
      request: FastifyRequest<{ Params: { poolId: string } }>,
      reply: FastifyReply,
    ) => {
      const pool = await fetchJson(
        identity,
        request,
        poolPath(request.params.poolId),
      );
      if (pool.status === 404)
        throw new AppError(404, "NOT_FOUND", "User pool not found");
      if (pool.status !== 200)
        throw new AppError(
          502,
          "UPSTREAM_UNAVAILABLE",
          "Identity service is unavailable",
        );
      return readEvents(
        request,
        reply,
        `/pools/${encodeURIComponent(request.params.poolId)}/events`,
      );
    },
  };
}

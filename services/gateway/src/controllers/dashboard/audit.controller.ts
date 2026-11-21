import type { FastifyReply, FastifyRequest } from "fastify";
import type { Upstream } from "../../services/upstream.service.js";

export function auditController(auditService: Upstream, auditToken: string) {
  return {
    list: (request: FastifyRequest, reply: FastifyReply) => {
      const search = new URLSearchParams();
      for (const [name, value] of Object.entries(
        request.query as Record<string, string | number | undefined>,
      )) {
        if (value !== undefined) search.set(name, String(value));
      }
      const query = search.size > 0 ? `?${search.toString()}` : "";
      return auditService.forward(request, reply, {
        method: "GET",
        path: `/events${query}`,
        headers: {
          authorization: `Bearer ${auditToken}`,
          "x-audit-service": "gateway",
        },
      });
    },
  };
}

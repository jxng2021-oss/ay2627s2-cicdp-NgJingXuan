import type { listAuditEventsSchema } from "../api/audit-schemas.js";
import type { Upstream } from "../services/upstream.service.js";
import type { Rep, Req } from "../types.js";

export function createAuditEventsController(
  audit: Upstream,
  auditToken: string,
) {
  return {
    list: (
      request: Req<typeof listAuditEventsSchema>,
      reply: Rep<typeof listAuditEventsSchema>,
    ) => {
      const search = new URLSearchParams();
      for (const [name, value] of Object.entries(request.query)) {
        if (value !== undefined) search.set(name, String(value));
      }
      const query = search.size > 0 ? `?${search.toString()}` : "";
      return audit.forward(request, reply, {
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

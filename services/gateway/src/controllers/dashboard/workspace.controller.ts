import type { FastifyRequest } from "fastify";
import type { Upstream } from "../../services/upstream.service.js";
import { fetchJson } from "../../services/upstream.service.js";
import type { WorkspaceMembership } from "../../models/membership.model.js";

export function workspaceController(services: {
  secrets: Upstream;
  storage: Upstream;
}) {
  async function count(
    upstream: Upstream,
    request: FastifyRequest,
    path: string,
    key: "secrets" | "files",
  ): Promise<number | null> {
    let total = 0;
    let cursor: string | null = null;
    for (let page = 0; page < 1000; page++) {
      const query: string = cursor
        ? `&cursor=${encodeURIComponent(cursor)}`
        : "";
      const { status, body } = await fetchJson(
        upstream,
        request,
        `${path}?limit=100${query}`,
      );
      if (status !== 200) return null;
      const list = body as Record<string, unknown[] | string | null>;
      total += (list[key] as unknown[]).length;
      cursor = (list.nextCursor as string | null) ?? null;
      if (!cursor) return total;
    }
    return total;
  }

  return {
    overview: async (
      request: FastifyRequest,
      workspace: WorkspaceMembership,
    ) => {
      const [secretsCount, fileCount, usage, ready] = await Promise.all([
        count(services.secrets, request, "/secrets", "secrets"),
        count(services.storage, request, "/files", "files"),
        fetchJson(services.storage, request, "/usage"),
        fetchJson(services.secrets, request, "/ready"),
      ]);
      const readiness = ready.body as
        { checks?: { seal?: string } } | undefined;
      const seal = readiness?.checks?.seal;
      return {
        id: workspace.tenantId,
        name: workspace.name,
        role: workspace.role,
        secretsCount,
        fileCount,
        storage:
          usage.status === 200
            ? (usage.body as {
                usedBytes: number;
                reservedBytes: number;
                limitBytes: number;
              })
            : null,
        secretsSealed: seal === undefined ? null : seal !== "unsealed",
      };
    },
  };
}

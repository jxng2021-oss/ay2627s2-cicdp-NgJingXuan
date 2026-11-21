import type { FastifyRequest } from "fastify";
import type { ProxyErrorCode } from "../api/proxy-schemas.js";
import type { ErrorCode } from "../api/schemas.js";
import type { AuditClient } from "../audit.js";
import type { Database } from "../db/client.js";
import {
  finishWorkspaceDeletion,
  startWorkspaceDeletion,
} from "../models/workspace.model.js";
import {
  deleteInternal,
  fetchJson,
  type Upstream,
} from "./upstream.service.js";

export interface DeletionRefused {
  status: number;
  code: ErrorCode | ProxyErrorCode;
  message: string;
  retryAfter?: number;
}

export interface DeletionServices {
  secrets: Upstream;
  storage: Upstream;
  identity: Upstream;
  flags: Upstream;
}

const failed: DeletionRefused = {
  status: 502,
  code: "UPSTREAM_UNAVAILABLE",
  message: "The deletion didn't finish: try again",
};

export function workspaceDeletionService(
  db: Database,
  audit: AuditClient,
  services: DeletionServices,
) {
  return async function deleteWorkspace(
    request: FastifyRequest,
    alreadyDeleting: boolean,
  ): Promise<DeletionRefused | undefined> {
    if (!alreadyDeleting) {
      const ready = await fetchJson(services.secrets, request, "/ready");
      const seal = (ready.body as { checks?: { seal?: string } } | undefined)
        ?.checks?.seal;
      if (seal !== "unsealed") {
        return {
          status: 503,
          code: "SECRETS_SEALED",
          message:
            "The secrets service is sealed, so the workspace's key can't be destroyed yet. Nothing was changed.",
          retryAfter: 30,
        };
      }
      try {
        await audit.record(
          {
            action: "tenant.shredded",
            outcome: "success",
            actorType: "user",
            actorId: request.dashboardUserId,
            tenantId: request.tenantId,
            resourceId: request.tenantId,
            requestId: request.id,
            sourceIp: request.ip,
          },
          request.log,
        );
      } catch {
        return {
          status: 503,
          code: "SERVICE_UNAVAILABLE",
          message:
            "The audit log is unavailable, so the deletion was refused. Nothing was changed.",
        };
      }
      await startWorkspaceDeletion(db, request.tenantId);
    }

    const secrets = await deleteInternal(
      services.secrets,
      request,
      "/internal/tenant",
    );
    if (secrets.status === 503 && secrets.code === "SECRETS_SEALED") {
      return {
        status: 503,
        code: "SECRETS_SEALED",
        message:
          "The secrets service was sealed part-way. Unseal it, then finish the deletion.",
        retryAfter: 30,
      };
    }
    if (secrets.status !== 204) return failed;

    for (const [upstream, path] of [
      [services.storage, "/tenant"],
      [services.identity, "/tenant"],
      [services.flags, "/tenant"],
    ] as const) {
      const result = await deleteInternal(upstream, request, path);
      if (result.status !== 204) return failed;
    }

    await finishWorkspaceDeletion(db, request.tenantId);
    request.log.info("workspace crypto-shredded");
    return undefined;
  };
}

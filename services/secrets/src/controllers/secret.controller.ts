import type { FastifyReply, FastifyRequest } from "fastify";
import type { Static } from "typebox";
import type { AuditClient, AuditEvent } from "../audit.js";
import { AppError } from "../errors.js";
import type {
  ListQuery,
  NameParams,
  ValueBody,
  VersionQuery,
  VersionsQuery,
} from "../schemas.js";
import type { SecretService } from "../services/secret.service.js";

type Named = { Params: Static<typeof NameParams> };
type WithValue = Named & { Body: Static<typeof ValueBody> };

const notFound = () => new AppError(404, "NOT_FOUND", "Secret not found");

function metadata(saved: { name: string; version: number; createdAt: Date }) {
  return {
    name: saved.name,
    version: saved.version,
    createdAt: saved.createdAt.toISOString(),
  };
}

export function createSecretController(
  secrets: SecretService,
  audit: AuditClient,
  maxSecretBytes: number,
) {
  const event = (
    request: FastifyRequest,
    action: string,
    name: string,
  ): AuditEvent => ({
    action,
    outcome: "success",
    actorType: request.actorId ? request.actorType : "service",
    actorId: request.actorId,
    tenantId: request.tenantId,
    resourceId: name,
    requestId: request.id,
    sourceIp: request.clientIp,
  });

  const record = (request: FastifyRequest, action: string, name: string) =>
    audit.record(event(request, action, name), request.log);

  const checkSize = (value: string) => {
    if (Buffer.byteLength(value, "utf8") > maxSecretBytes)
      throw new AppError(
        413,
        "PAYLOAD_TOO_LARGE",
        "The secret value is larger than the allowed maximum",
      );
  };

  return {
    list: async (
      request: FastifyRequest<{ Querystring: Static<typeof ListQuery> }>,
    ) => {
      const page = await secrets.list(
        request.tenantId,
        request.query.limit ?? 20,
        request.query.cursor,
      );
      return {
        secrets: page.items.map((s) => ({
          name: s.name,
          latestVersion: s.latestVersion,
          createdAt: s.createdAt.toISOString(),
          updatedAt: s.updatedAt.toISOString(),
        })),
        nextCursor: page.nextCursor,
      };
    },

    save: async (request: FastifyRequest<WithValue>, reply: FastifyReply) => {
      checkSize(request.body.value);
      const saved = await secrets.save(
        request.tenantId,
        request.params.name,
        request.body.value,
        (version) =>
          record(
            request,
            version.version === 1 ? "secret.created" : "secret.rotated",
            version.name,
          ),
      );
      return reply.code(saved.version === 1 ? 201 : 200).send(metadata(saved));
    },

    rotate: async (request: FastifyRequest<WithValue>) => {
      checkSize(request.body.value);
      const saved = await secrets.rotate(
        request.tenantId,
        request.params.name,
        request.body.value,
        (version) => record(request, "secret.rotated", version.name),
      );
      if (!saved) throw notFound();
      return metadata(saved);
    },

    describe: async (
      request: FastifyRequest<
        Named & { Querystring: Static<typeof VersionQuery> }
      >,
    ) => {
      const found = await secrets.describe(
        request.tenantId,
        request.params.name,
        request.query.version,
      );
      if (!found) throw notFound();
      return metadata(found);
    },

    versions: async (
      request: FastifyRequest<
        Named & { Querystring: Static<typeof VersionsQuery> }
      >,
    ) => {
      const { cursor } = request.query;
      const page = await secrets.versions(
        request.tenantId,
        request.params.name,
        request.query.limit ?? 20,
        cursor === undefined ? undefined : Number(cursor),
      );
      if (!page) throw notFound();
      return {
        name: request.params.name,
        versions: page.items.map((v) => ({
          version: v.version,
          createdAt: v.createdAt.toISOString(),
        })),
        nextCursor: page.nextCursor,
      };
    },

    remove: async (request: FastifyRequest<Named>, reply: FastifyReply) => {
      const deleted = await secrets.delete(
        request.tenantId,
        request.params.name,
        () => record(request, "secret.deleted", request.params.name),
      );
      if (!deleted) throw notFound();
      return reply.code(204).send();
    },

    readForInjection: async (request: FastifyRequest<Named>) => {
      const found = await secrets.read(request.tenantId, request.params.name);
      if (!found) throw notFound();
      await record(request, "secret.read", found.name);
      return { name: found.name, version: found.version, value: found.value };
    },

    shredTenant: async (request: FastifyRequest, reply: FastifyReply) => {
      await secrets.shred(request.tenantId);
      request.log.info("tenant crypto-shredded: its key was destroyed");
      return reply.code(204).send();
    },
  };
}

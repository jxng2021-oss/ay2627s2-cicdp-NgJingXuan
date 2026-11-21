import type { Static } from "typebox";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Flag } from "../db/schema.js";
import type {
  EnvironmentParams,
  EnvironmentSettings,
  EvaluateBody,
  FlagChangesBody,
  FlagParams,
  NewFlagBody,
} from "../schemas.js";
import type { Actor, FlagService } from "../services/flag.service.js";

type Params = { Params: Static<typeof FlagParams> };

export function actorOf(request: FastifyRequest): Actor {
  return {
    tenantId: request.tenantId,
    actorId: request.actorId,
    actorType: request.actorType,
    clientIp: request.clientIp,
    requestId: request.id,
    log: request.log,
  };
}

export function flagJson(flag: Flag) {
  return {
    key: flag.key,
    description: flag.description,
    kind: flag.kind,
    offValue: flag.offValue,
    environments: flag.environments,
    createdAt: flag.createdAt.toISOString(),
    updatedAt: flag.updatedAt.toISOString(),
  };
}

export function createFlagController(flags: FlagService) {
  return {
    list: async (request: FastifyRequest) => ({
      flags: (await flags.list(actorOf(request))).map(flagJson),
    }),

    create: async (
      request: FastifyRequest<{ Body: Static<typeof NewFlagBody> }>,
      reply: FastifyReply,
    ) => {
      const flag = await flags.create(actorOf(request), request.body);
      return reply.code(201).send(flagJson(flag));
    },

    get: async (request: FastifyRequest<Params>) =>
      flagJson(await flags.get(actorOf(request), request.params.key)),

    update: async (
      request: FastifyRequest<
        Params & { Body: Static<typeof FlagChangesBody> }
      >,
    ) =>
      flagJson(
        await flags.update(
          actorOf(request),
          request.params.key,
          request.body.description,
        ),
      ),

    setEnvironment: async (
      request: FastifyRequest<{
        Params: Static<typeof EnvironmentParams>;
        Body: Static<typeof EnvironmentSettings>;
      }>,
    ) =>
      flagJson(
        await flags.setEnvironment(
          actorOf(request),
          request.params.key,
          request.params.environment,
          request.body,
        ),
      ),

    remove: async (request: FastifyRequest<Params>, reply: FastifyReply) => {
      await flags.remove(actorOf(request), request.params.key);
      return reply.code(204).send();
    },

    evaluate: async (
      request: FastifyRequest<{ Body: Static<typeof EvaluateBody> }>,
    ) => {
      const { environment, context, keys } = request.body;
      return {
        environment,
        flags: await flags.evaluate(
          actorOf(request),
          environment,
          context,
          keys,
        ),
      };
    },

    removeTenant: async (request: FastifyRequest, reply: FastifyReply) => {
      await flags.removeTenant(actorOf(request));
      request.log.info("the tenant's feature flags were deleted");
      return reply.code(204).send();
    },
  };
}

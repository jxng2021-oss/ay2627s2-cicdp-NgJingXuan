import type { FastifyReply, FastifyRequest } from "fastify";
import {
  secretPath,
  type secretsForwarder,
} from "../../services/secrets.service.js";

type Forwarder = ReturnType<typeof secretsForwarder>;
type Query = { limit?: number; cursor?: string };

export function secretsController(secrets: Forwarder) {
  const name = (request: FastifyRequest) =>
    (request.params as { name: string }).name;

  return {
    list: (request: FastifyRequest, reply: FastifyReply) => {
      const { limit, cursor } = request.query as Query;
      return secrets.forward(request, reply, "GET", "/secrets", {
        limit,
        cursor,
      });
    },

    put: (
      request: FastifyRequest<{ Body: { value: string } }>,
      reply: FastifyReply,
    ) => {
      return secrets.forwardValue(
        request,
        reply,
        "PUT",
        secretPath(name(request)),
        request.body.value,
      );
    },

    rotate: (
      request: FastifyRequest<{ Body: { value: string } }>,
      reply: FastifyReply,
    ) => {
      return secrets.forwardValue(
        request,
        reply,
        "POST",
        `${secretPath(name(request))}/rotate`,
        request.body.value,
      );
    },

    versions: (request: FastifyRequest, reply: FastifyReply) => {
      const { limit, cursor } = request.query as Query;
      return secrets.forward(
        request,
        reply,
        "GET",
        `${secretPath(name(request))}/versions`,
        {
          limit,
          cursor,
        },
      );
    },

    remove: (request: FastifyRequest, reply: FastifyReply) => {
      return secrets.forward(
        request,
        reply,
        "DELETE",
        secretPath(name(request)),
      );
    },
  };
}

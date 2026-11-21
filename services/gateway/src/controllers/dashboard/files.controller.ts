import type { FastifyReply, FastifyRequest } from "fastify";
import type { storageForwarder } from "../../services/storage.service.js";

type Forwarder = ReturnType<typeof storageForwarder>;

export function filesController(storage: Forwarder) {
  const id = (request: FastifyRequest) => (request.params as { id: string }).id;

  return {
    list: (request: FastifyRequest, reply: FastifyReply) => {
      const { limit, cursor } = request.query as {
        limit?: number;
        cursor?: string;
      };
      const query = new URLSearchParams();
      if (limit !== undefined) query.set("limit", String(limit));
      if (cursor !== undefined) query.set("cursor", cursor);
      const search = query.size > 0 ? `?${query.toString()}` : "";
      return storage.forward(request, reply, "GET", `/files${search}`, false);
    },
    upload: (request: FastifyRequest, reply: FastifyReply) =>
      storage.forward(request, reply, "POST", "/files", true),
    download: (request: FastifyRequest, reply: FastifyReply) =>
      storage.forward(request, reply, "GET", `/files/${id(request)}`, false),
    metadata: (request: FastifyRequest, reply: FastifyReply) =>
      storage.forward(
        request,
        reply,
        "GET",
        `/files/${id(request)}/metadata`,
        false,
      ),
    remove: (request: FastifyRequest, reply: FastifyReply) =>
      storage.forward(request, reply, "DELETE", `/files/${id(request)}`, false),
    usage: (request: FastifyRequest, reply: FastifyReply) =>
      storage.forward(request, reply, "GET", "/usage", false),
  };
}

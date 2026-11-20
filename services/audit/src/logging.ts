import type { FastifyInstance } from "fastify";

export function logRequests(app: FastifyInstance): void {
  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions.url ?? "unmatched";
    const durationMs = Math.round(reply.elapsedTime * 10) / 10;
    request.log.info(
      { method: request.method, route, status: reply.statusCode, durationMs },
      "request completed",
    );
  });
}

export function loggerOptions(
  logger: boolean | object | undefined,
  service: string,
  version: string,
): false | object {
  if (!logger) return false;
  return {
    ...(typeof logger === "object" ? logger : {}),
    base: { service, version },
  };
}

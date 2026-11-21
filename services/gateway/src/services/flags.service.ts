import type { FastifyReply, FastifyRequest } from "fastify";
import { Upstream } from "./upstream.service.js";

export interface FlagsOptions {
  flagsUrl: string;
  connectTimeoutMs: number;
  responseTimeoutMs: number;
}

export function flagsForwarder(options: FlagsOptions) {
  const flags = new Upstream({
    label: "Flags service",
    baseUrl: options.flagsUrl,
    connectTimeoutMs: options.connectTimeoutMs,
    responseTimeoutMs: options.responseTimeoutMs,
  });

  function forward(
    request: FastifyRequest,
    reply: FastifyReply,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: object,
  ) {
    return flags.forward(request, reply, {
      method,
      path,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  return { forward, upstream: flags, close: () => flags.close() };
}

export const flagPath = (key: string, rest = "") =>
  `/flags/${encodeURIComponent(key)}${rest}`;

export type FlagsForwarder = ReturnType<typeof flagsForwarder>;

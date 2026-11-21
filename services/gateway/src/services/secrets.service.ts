import type { FastifyReply, FastifyRequest } from "fastify";
import { sendError } from "../errors.js";
import { Upstream } from "./upstream.service.js";

export interface SecretsProxyOptions {
  secretsUrl: string;
  connectTimeoutMs: number;
  responseTimeoutMs: number;
  maxSecretBytes: number;
}

export function secretsForwarder(options: SecretsProxyOptions) {
  const secrets = new Upstream({
    label: "Secrets service",
    baseUrl: options.secretsUrl,
    connectTimeoutMs: options.connectTimeoutMs,
    responseTimeoutMs: options.responseTimeoutMs,
  });

  function forwardValue(
    request: FastifyRequest,
    reply: FastifyReply,
    method: "PUT" | "POST",
    path: string,
    value: string,
  ) {
    if (Buffer.byteLength(value, "utf8") > options.maxSecretBytes) {
      return sendError(
        reply,
        413,
        "PAYLOAD_TOO_LARGE",
        "The secret value is larger than the allowed maximum",
      );
    }
    return secrets.forward(request, reply, {
      method,
      path,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value }),
    });
  }

  function forward(
    request: FastifyRequest,
    reply: FastifyReply,
    method: "GET" | "POST" | "DELETE",
    path: string,
    query: Record<string, string | number | undefined> = {},
  ) {
    const search = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined) search.set(name, String(value));
    }
    const queryString = search.size > 0 ? `?${search.toString()}` : "";
    return secrets.forward(request, reply, {
      method: request.method === "HEAD" ? "HEAD" : method,
      path: path + queryString,
      headers: {},
    });
  }

  return {
    forward,
    forwardValue,
    upstream: secrets,
    close: () => secrets.close(),
  };
}

export type SecretsForwarder = ReturnType<typeof secretsForwarder>;

export function secretPath(name: string): string {
  return `/secrets/${encodeURIComponent(name)}`;
}

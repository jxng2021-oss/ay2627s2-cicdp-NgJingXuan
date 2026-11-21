import type { IncomingMessage } from "node:http";
import type { FastifyReply, FastifyRequest } from "fastify";
import { limitBody } from "../body-limit.js";
import { sendError } from "../errors.js";
import {
  HOP_BY_HOP_HEADERS,
  Upstream,
  withoutHeaders,
} from "./upstream.service.js";

export interface StorageProxyOptions {
  storageUrl: string;
  connectTimeoutMs: number;
  responseTimeoutMs: number;
  maxUploadBytes: number;
}

const NOT_FORWARDED_TO_STORAGE = new Set([
  ...HOP_BY_HOP_HEADERS,
  "authorization",
  "x-tenant-id",
  "x-request-id",
  "x-actor-id",
  "x-actor-type",
  "x-client-ip",
  "cookie",
  "x-csrf-token",
]);

export function storageForwarder(options: StorageProxyOptions) {
  const storage = new Upstream({
    label: "Storage service",
    baseUrl: options.storageUrl,
    connectTimeoutMs: options.connectTimeoutMs,
    responseTimeoutMs: options.responseTimeoutMs,
  });

  async function forward(
    request: FastifyRequest,
    reply: FastifyReply,
    method: "GET" | "POST" | "DELETE",
    storagePath: string,
    hasBody: boolean,
  ) {
    const declaredLength = Number(request.headers["content-length"]);
    if (hasBody && declaredLength > options.maxUploadBytes) {
      return payloadTooLarge(reply);
    }
    let bodyTooLarge = false;
    const body = hasBody
      ? limitBody(request.raw, options.maxUploadBytes, () => {
          bodyTooLarge = true;
        })
      : undefined;

    return storage.forward(request, reply, {
      method: request.method === "HEAD" ? "HEAD" : method,
      path: storagePath,
      headers: withoutHeaders(request.headers, NOT_FORWARDED_TO_STORAGE),
      body,
      onFailure: () => (bodyTooLarge ? payloadTooLarge(reply) : undefined),
    });
  }

  return { forward, upstream: storage, close: () => storage.close() };
}

export type StorageForwarder = ReturnType<typeof storageForwarder>;

function payloadTooLarge(reply: FastifyReply) {
  discardRestOfBody(reply.request.raw);
  return sendError(
    reply,
    413,
    "PAYLOAD_TOO_LARGE",
    "The upload is larger than the allowed maximum",
  );
}

function discardRestOfBody(body: IncomingMessage): void {
  if (body.readableEnded) return;
  body.resume();
  const timer = setTimeout(() => body.socket.destroy(), 5_000);
  timer.unref();
  body.once("end", () => clearTimeout(timer));
  body.once("close", () => clearTimeout(timer));
}

import type { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Agent, errors, request as sendUpstream } from "undici";
import { sendError } from "../errors.js";

export interface UpstreamOptions {
  label: string;
  baseUrl: string;
  connectTimeoutMs: number;
  responseTimeoutMs: number;
}

export const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "expect",
]);

export class Upstream {
  readonly agent: Agent;
  private readonly baseUrl: string;

  constructor(private readonly options: UpstreamOptions) {
    this.agent = new Agent({
      connectTimeout: options.connectTimeoutMs,
      headersTimeout: options.responseTimeoutMs,
      bodyTimeout: options.responseTimeoutMs,
    });
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
  }

  close(): Promise<void> {
    return this.agent.close();
  }

  url(path: string): string {
    return this.baseUrl + path;
  }

  async forward(
    request: FastifyRequest,
    reply: FastifyReply,
    upstream: {
      method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
      path: string;
      headers: Record<string, string | string[]>;
      body?: string | Readable;
      onFailure?: () => FastifyReply | undefined;
    },
  ) {
    try {
      const response = await sendUpstream(this.baseUrl + upstream.path, {
        dispatcher: this.agent,
        method: upstream.method,
        headers: {
          ...upstream.headers,
          ...(request.tenantId ? { "x-tenant-id": request.tenantId } : {}),
          "x-request-id": request.id,
          ...auditHeaders(request),
        },
        body: upstream.body,
      });

      reply.code(response.statusCode);
      for (const [name, value] of Object.entries(
        withoutHeaders(response.headers, HOP_BY_HOP_HEADERS),
      )) {
        reply.header(name, value);
      }
      return await reply.send(response.body);
    } catch (error) {
      const handled = upstream.onFailure?.();
      if (handled) return handled;
      request.log.warn({ err: error }, `${this.options.label} request failed`);
      return isTimeout(error)
        ? sendError(
            reply,
            504,
            "UPSTREAM_TIMEOUT",
            `${this.options.label} did not respond in time`,
          )
        : sendError(
            reply,
            502,
            "UPSTREAM_UNAVAILABLE",
            `${this.options.label} is unavailable`,
          );
    }
  }
}

export function auditHeaders(request: FastifyRequest): Record<string, string> {
  return {
    ...(request.apiKeyId ? { "x-actor-id": request.apiKeyId } : {}),
    "x-client-ip": request.ip,
  };
}

export async function fetchJson(
  upstream: Upstream,
  request: FastifyRequest,
  path: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  try {
    const response = await sendUpstream(upstream.url(path), {
      dispatcher: upstream.agent,
      headers: {
        ...extraHeaders,
        "x-tenant-id": request.tenantId,
        "x-request-id": request.id,
        ...auditHeaders(request),
      },
    });
    const body: unknown = await response.body.json().catch(() => undefined);
    return { status: response.statusCode, body };
  } catch (error) {
    request.log.warn({ err: error }, "internal service request failed");
    return { status: 0, body: undefined };
  }
}

export async function deleteInternal(
  upstream: Upstream,
  request: FastifyRequest,
  path: string,
): Promise<{ status: number; code?: string }> {
  try {
    const response = await sendUpstream(upstream.url(path), {
      dispatcher: upstream.agent,
      method: "DELETE",
      headers: {
        "x-tenant-id": request.tenantId,
        "x-request-id": request.id,
        ...auditHeaders(request),
      },
    });
    const body = (await response.body.json().catch(() => undefined)) as
      { error?: { code?: string } } | undefined;
    return { status: response.statusCode, code: body?.error?.code };
  } catch (error) {
    request.log.warn({ err: error }, "internal service request failed");
    return { status: 0 };
  }
}

export function withoutHeaders(
  headers: Record<string, string | string[] | undefined>,
  excluded: Set<string>,
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !excluded.has(name.toLowerCase())) {
      result[name] = value;
    }
  }
  return result;
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof errors.ConnectTimeoutError ||
    error instanceof errors.HeadersTimeoutError ||
    error instanceof errors.BodyTimeoutError
  );
}

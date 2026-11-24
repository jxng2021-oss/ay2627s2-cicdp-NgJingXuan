import type { IncomingMessage } from "node:http";
import type { LookupFunction } from "node:net";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Agent, errors, request as sendRequest } from "undici";
import { limitBody } from "../body-limit.js";
import type { Database } from "../db/client.js";
import type { ProxyConnection } from "../db/schema.js";
import { sendError } from "../errors.js";
import { serviceUnavailable } from "../limits.js";
import type { RateLimitStore } from "../rate-limit.js";
import type { AuditClient } from "../audit.js";
import {
  AMOUNT_METHODS,
  amountFrom,
  DENIAL_MESSAGES,
  MAX_AMOUNT_BODY_BYTES,
  policyKeys,
  routeAllowed,
  utcDay,
  type DenialReason,
} from "./policy.service.js";
import type { ProxyPolicy, Resolver } from "./ssrf.service.js";
import { auditHeaders, HOP_BY_HOP_HEADERS } from "./upstream.service.js";

export interface ProxyRouteOptions {
  db: Database;
  policy: ProxyPolicy;
  resolver: Resolver;
  secretsUrl: string;
  connectTimeoutMs: number;
  responseTimeoutMs: number;
  maxUploadBytes: number;
  audit: AuditClient;
  rateLimitStore: RateLimitStore;
}

export interface PolicyPass {
  body?: Buffer;
  refund: () => Promise<void>;
}

declare module "fastify" {
  interface FastifyRequest {
    proxyConnectionName: string | undefined;
    proxyOutcome: "success" | "denied" | "policy_denied" | "failure";
  }
}

const NOT_FORWARDED = new Set([
  ...HOP_BY_HOP_HEADERS,
  "authorization",
  "cookie",
  "x-tenant-id",
  "x-request-id",
]);

const NOT_RETURNED = new Set([...HOP_BY_HOP_HEADERS, "set-cookie"]);

const SAFE_HEADER_VALUE = /^[\t\x20-\x7e]*$/;

export type ProxyService = ReturnType<typeof createProxyService>;

export function createProxyService(options: ProxyRouteOptions) {
  const secretsAgent = new Agent({
    connectTimeout: options.connectTimeoutMs,
    headersTimeout: options.responseTimeoutMs,
    bodyTimeout: options.responseTimeoutMs,
  });

  async function enforcePolicy(
    request: FastifyRequest,
    reply: FastifyReply,
    connection: ProxyConnection,
  ): Promise<PolicyPass | undefined> {
    const policy = connection.policy;
    const pass: PolicyPass = { refund: () => Promise.resolve() };
    if (!policy) return pass;

    const deny = (reason: DenialReason) => {
      request.proxyOutcome = "policy_denied";
      request.log.info(
        { connection: connection.name, reason },
        "proxy call refused by the connection's policy",
      );
      sendError(reply, 403, "PROXY_POLICY_DENIED", DENIAL_MESSAGES[reason]);
      return undefined;
    };

    const path = clientPath(request.raw.url ?? "");
    if (!routeAllowed(policy, request.method, path)) {
      return deny("route_not_allowed");
    }

    const amountLimit = AMOUNT_METHODS.has(request.method)
      ? policy.amountLimit
      : undefined;
    let amount: number | undefined;
    if (amountLimit) {
      if (Number(request.headers["content-length"]) > MAX_AMOUNT_BODY_BYTES) {
        return smallBodyOnly(reply);
      }
      const body = await readSmallBody(request.raw, MAX_AMOUNT_BODY_BYTES);
      if (body === "too-large") return smallBodyOnly(reply);
      amount = amountFrom(
        body,
        amountLimit.field,
        request.headers["content-type"] ?? "",
      );
      if (amount === undefined) return deny("amount_missing");
      if (amount > amountLimit.maxPerRequest) return deny("amount_too_high");
      pass.body = body;
    }

    const { day, endsAtMs } = utcDay();
    const keys = policyKeys(request.tenantId, connection.name, day);
    const store = options.rateLimitStore;
    try {
      if (policy.rateLimit) {
        const window = await store.hit(
          keys.calls,
          policy.rateLimit.windowSeconds * 1000,
        );
        if (window.count > policy.rateLimit.requests) {
          request.proxyOutcome = "policy_denied";
          request.log.info(
            { connection: connection.name, reason: "rate_limited" },
            "proxy call refused by the connection's policy",
          );
          reply.header(
            "retry-after",
            Math.max(1, Math.ceil(window.resetMs / 1000)),
          );
          sendError(
            reply,
            429,
            "PROXY_RATE_LIMITED",
            "The connection's rate limit is reached",
          );
          return undefined;
        }
      }
      if (amountLimit && amount !== undefined) {
        const reserved = await store.reserve(
          keys.amount,
          amount,
          amountLimit.maxPerDay,
          endsAtMs,
        );
        if (!reserved.reserved) return deny("daily_limit_reached");
        const reservedAmount = amount;
        pass.refund = () =>
          store.release(keys.amount, reservedAmount).catch((error: unknown) => {
            request.log.warn(
              { err: error, connection: connection.name },
              "couldn't give back a reserved amount",
            );
          });
      }
    } catch (error) {
      request.log.warn(
        { err: error, connection: connection.name },
        "connection policy counters unavailable: refusing the call",
      );
      serviceUnavailable(
        reply,
        "The connection's policy can't be checked right now, try again shortly",
      );
      return undefined;
    }
    return pass;
  }

  async function fetchSecret(
    request: FastifyRequest,
    reply: FastifyReply,
    connection: ProxyConnection,
  ): Promise<string | undefined> {
    try {
      const response = await sendRequest(
        `${options.secretsUrl.replace(/\/$/, "")}/internal/secrets/${encodeURIComponent(connection.secretName)}`,
        {
          dispatcher: secretsAgent,
          headers: {
            "x-tenant-id": request.tenantId,
            "x-request-id": request.id,
            ...auditHeaders(request),
          },
        },
      );
      const body = (await response.body.json().catch(() => ({}))) as {
        value?: unknown;
        error?: { code?: string };
      };
      if (response.statusCode === 200 && typeof body.value === "string") {
        return body.value;
      }
      if (response.statusCode === 404) {
        sendError(
          reply,
          409,
          "PROXY_SECRET_MISSING",
          `The connection's secret "${connection.secretName}" doesn't exist`,
        );
      } else if (
        response.statusCode === 503 &&
        body.error?.code === "SECRETS_SEALED"
      ) {
        reply.header("retry-after", 30);
        sendError(
          reply,
          503,
          "SECRETS_SEALED",
          "The secrets service is sealed until an operator unseals it",
        );
      } else {
        request.log.warn(
          { statusCode: response.statusCode },
          "secrets service refused the injection secret",
        );
        sendError(
          reply,
          502,
          "UPSTREAM_UNAVAILABLE",
          "Secrets service is unavailable",
        );
      }
    } catch (error) {
      request.log.warn({ err: error }, "secrets service request failed");
      if (isTimeout(error)) {
        sendError(
          reply,
          504,
          "UPSTREAM_TIMEOUT",
          "Secrets service did not respond in time",
        );
      } else {
        sendError(
          reply,
          502,
          "UPSTREAM_UNAVAILABLE",
          "Secrets service is unavailable",
        );
      }
    }
    return undefined;
  }

  async function forward(
    request: FastifyRequest,
    reply: FastifyReply,
    connection: ProxyConnection,
    target: URL,
    pinned: { address: string; family: 4 | 6 },
    secret: string,
    pass: PolicyPass,
  ) {
    const headerValue = `${connection.headerPrefix}${secret}`;
    if (!SAFE_HEADER_VALUE.test(headerValue)) {
      await pass.refund();
      return sendError(
        reply,
        502,
        "UPSTREAM_UNAVAILABLE",
        "The connection's secret can't be sent in a header",
      );
    }

    const declaredLength = Number(request.headers["content-length"]);
    if (declaredLength > options.maxUploadBytes) return payloadTooLarge(reply);
    let bodyTooLarge = false;
    const hasBody =
      !["GET", "HEAD"].includes(request.method) &&
      (declaredLength > 0 ||
        request.headers["transfer-encoding"] !== undefined);
    const body =
      pass.body ??
      (hasBody
        ? limitBody(request.raw, options.maxUploadBytes, () => {
            bodyTooLarge = true;
          })
        : undefined);

    const headers = forwardedHeaders(request.headers, connection.headerName);
    headers[connection.headerName.toLowerCase()] = headerValue;

    const dispatcher = new Agent({
      connect: {
        lookup: pinnedLookup(pinned),
        timeout: options.connectTimeoutMs,
      },
      headersTimeout: options.responseTimeoutMs,
      bodyTimeout: options.responseTimeoutMs,
    });
    reply.raw.once("close", () => void dispatcher.destroy());

    try {
      const response = await sendRequest(target, {
        dispatcher,
        method: request.method as "GET",
        headers,
        body,
      });

      if (response.statusCode >= 300) await pass.refund();
      if (isRedirect(response.statusCode)) {
        await response.body.dump();
        return sendError(
          reply,
          502,
          "UPSTREAM_REDIRECT",
          "The outside API answered with a redirect, which isn't followed",
        );
      }

      request.proxyOutcome = "success";
      reply.code(response.statusCode);
      const dropped = listedInConnection(response.headers.connection);
      for (const [name, value] of Object.entries(response.headers)) {
        const lower = name.toLowerCase();
        if (
          value !== undefined &&
          !NOT_RETURNED.has(lower) &&
          !dropped.has(lower)
        ) {
          reply.header(name, value);
        }
      }
      return await reply.send(response.body);
    } catch (error) {
      await pass.refund();
      if (bodyTooLarge) return payloadTooLarge(reply);
      request.log.warn(
        { err: error, connection: connection.name },
        "outside API request failed",
      );
      return isTimeout(error)
        ? sendError(
            reply,
            504,
            "UPSTREAM_TIMEOUT",
            "The outside API did not respond in time",
          )
        : sendError(
            reply,
            502,
            "UPSTREAM_UNAVAILABLE",
            "The outside API is unavailable",
          );
    }
  }

  return {
    enforcePolicy,
    fetchSecret,
    forward,
    close: () => secretsAgent.close(),
  };
}

export function clientPath(rawUrl: string): string {
  const start = rawUrl.indexOf("/proxy/") + "/proxy/".length;
  const afterName = rawUrl.indexOf("/", start);
  return afterName === -1 ? "" : rawUrl.slice(afterName);
}

function forwardedHeaders(
  headers: FastifyRequest["headers"],
  injectedHeader: string,
): Record<string, string | string[]> {
  const dropped = listedInConnection(headers.connection);
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (
      value === undefined ||
      NOT_FORWARDED.has(lower) ||
      dropped.has(lower) ||
      lower === injectedHeader.toLowerCase()
    ) {
      continue;
    }
    result[lower] = value;
  }
  return result;
}

function listedInConnection(value: string | string[] | undefined): Set<string> {
  const text = Array.isArray(value) ? value.join(",") : (value ?? "");
  return new Set(
    text
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function pinnedLookup(pinned: {
  address: string;
  family: 4 | 6;
}): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address: pinned.address, family: pinned.family }]);
    } else {
      callback(null, pinned.address, pinned.family);
    }
  };
}

function readSmallBody(
  raw: IncomingMessage,
  max: number,
): Promise<Buffer | "too-large"> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      raw.off("data", onData);
      raw.off("end", onEnd);
      raw.off("error", onError);
      raw.off("close", onClose);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        cleanup();
        raw.pause();
        resolve("too-large");
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("client disconnected"));
    };
    raw.on("data", onData);
    raw.once("end", onEnd);
    raw.once("error", onError);
    raw.once("close", onClose);
  });
}

function smallBodyOnly(reply: FastifyReply) {
  reply.raw.once("finish", () => reply.request.raw.resume());
  sendError(
    reply,
    413,
    "PAYLOAD_TOO_LARGE",
    "Calls checked for an amount can have a JSON body of at most 16 KiB",
  );
  return undefined;
}

function isRedirect(statusCode: number): boolean {
  return statusCode >= 300 && statusCode < 400 && statusCode !== 304;
}

function payloadTooLarge(reply: FastifyReply) {
  reply.raw.once("finish", () => reply.request.raw.resume());
  return sendError(
    reply,
    413,
    "PAYLOAD_TOO_LARGE",
    "The upload is larger than the allowed maximum",
  );
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof errors.ConnectTimeoutError ||
    error instanceof errors.HeadersTimeoutError ||
    error instanceof errors.BodyTimeoutError
  );
}

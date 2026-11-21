import type { FastifyBaseLogger, FastifyReply } from "fastify";
import { sendError } from "./errors.js";
import type { LimitResult } from "./rate-limit.js";

export interface RateLimitSettings {
  windowMs: number;
  requestsPerKey: number;
  uploadsPerKey: number;
  failedAuthPerIp: number;
  adminPerIp: number;
}

export function setRateLimitHeaders(
  reply: FastifyReply,
  result: LimitResult,
): void {
  reply.header("ratelimit-limit", result.limit);
  reply.header("ratelimit-remaining", result.remaining);
  reply.header("ratelimit-reset", result.resetSeconds);
}

export function rateLimited(reply: FastifyReply, resetSeconds: number) {
  reply.header("retry-after", resetSeconds);
  return sendError(
    reply,
    429,
    "RATE_LIMITED",
    "Too many requests, try again later",
  );
}

export function serviceUnavailable(reply: FastifyReply, message: string) {
  reply.header("retry-after", 5);
  return sendError(reply, 503, "SERVICE_UNAVAILABLE", message);
}

export function rateLimitingDownWarning(): (
  log: FastifyBaseLogger,
  error: unknown,
) => void {
  let lastWarning = 0;
  return (log, error) => {
    const now = Date.now();
    if (now - lastWarning < 30_000) return;
    lastWarning = now;
    log.warn(
      { err: error },
      "Redis is unavailable: API requests are being served WITHOUT rate limits; admin routes and failed key attempts get 503",
    );
  };
}

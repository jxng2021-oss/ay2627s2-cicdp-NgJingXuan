import type { FastifyInstance, FastifyReply } from "fastify";
import type { ErrorCode } from "./api/schemas.js";
import { AuditUnavailableError } from "./audit.js";

export function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: ErrorCode | "CONFLICT",
  message: string,
) {
  return reply.code(statusCode).send({
    error: { code, message, requestId: reply.request.id },
  });
}

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | "CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function installErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((_request, reply) =>
    sendError(reply, 404, "NOT_FOUND", "Not found"),
  );

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return sendError(reply, error.status, error.code, error.message);
    }
    const statusCode = statusCodeOf(error);
    if (statusCode === 400) {
      const message = error instanceof Error ? error.message : "Bad request";
      return sendError(reply, 400, "BAD_REQUEST", message);
    }
    if (statusCode === 413) {
      return sendError(
        reply,
        413,
        "PAYLOAD_TOO_LARGE",
        "Request body is too large",
      );
    }
    if (statusCode === 415) {
      return sendError(
        reply,
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        "Unsupported content type",
      );
    }
    if (statusCode < 500) {
      return sendError(reply, statusCode, "BAD_REQUEST", "Bad request");
    }
    if (error instanceof AuditUnavailableError) {
      return sendError(
        reply,
        503,
        "SERVICE_UNAVAILABLE",
        "The audit log is unavailable, so this change was refused. Try again later.",
      );
    }
    request.log.error({ err: error }, "request failed");
    return sendError(reply, 500, "INTERNAL_ERROR", "Something went wrong");
  });
}

function statusCodeOf(error: unknown): number {
  if (
    error instanceof Error &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
  ) {
    return error.statusCode;
  }
  return 500;
}

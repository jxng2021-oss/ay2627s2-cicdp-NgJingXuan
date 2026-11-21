import type { FastifyInstance, FastifyReply } from "fastify";
import { AuditUnavailableError } from "./audit.js";

export type ErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "INTERNAL_ERROR"
  | "SERVICE_UNAVAILABLE";

export function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: ErrorCode,
  message: string,
) {
  return reply.code(statusCode).send({
    error: { code, message, requestId: reply.request.id },
  });
}

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
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
      const message =
        hasValidationDetails(error) && error instanceof Error
          ? error.message
          : "The request body or parameters are invalid";
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
        "Send the request body as application/json",
      );
    }
    if (statusCode < 500) {
      return sendError(reply, statusCode, "BAD_REQUEST", "Bad request");
    }
    if (error instanceof AuditUnavailableError) {
      if (reply.sent || reply.raw.headersSent) return;
      return sendError(
        reply,
        503,
        "SERVICE_UNAVAILABLE",
        "The audit log is unavailable, so this action was refused. Try again later.",
      );
    }
    request.log.error({ err: error }, "request failed");
    if (reply.sent || reply.raw.headersSent) return;
    return sendError(reply, 500, "INTERNAL_ERROR", "Something went wrong");
  });
}

function hasValidationDetails(error: unknown): boolean {
  return typeof error === "object" && error !== null && "validation" in error;
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

import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import {
  AlreadyInitialisedError,
  LeftoverDataError,
  NotInitialisedError,
  TooManyAttemptsError,
  UnsealFailedError,
  type SealManager,
} from "./seal/seal-manager.js";
import { InvalidShareError } from "./seal/shares.js";
import { AuditUnavailableError } from "./audit.js";

type OperatorErrorCode =
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "ALREADY_INITIALISED"
  | "LEFTOVER_DATA"
  | "NOT_INITIALISED"
  | "INVALID_SHARE"
  | "UNSEAL_FAILED"
  | "TOO_MANY_ATTEMPTS"
  | "AUDIT_UNAVAILABLE"
  | "INTERNAL_ERROR";

function fail(
  reply: FastifyReply,
  statusCode: number,
  code: OperatorErrorCode,
  message: string,
) {
  return reply.code(statusCode).send({ error: { code, message } });
}

export function buildOperatorApp(seal: SealManager): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 4096 });

  app.setNotFoundHandler((_request, reply) =>
    fail(reply, 404, "NOT_FOUND", "Unknown operator command"),
  );
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AlreadyInitialisedError) {
      return fail(
        reply,
        409,
        "ALREADY_INITIALISED",
        "The secrets service is already initialised (or being initialised)",
      );
    }
    if (error instanceof LeftoverDataError) {
      return fail(
        reply,
        409,
        "LEFTOVER_DATA",
        "The secrets database still has keys or secrets from an earlier setup, which can't be decrypted by new keys. Locally, reset it with `pnpm local:reset` (deletes all local data).",
      );
    }
    if (error instanceof NotInitialisedError) {
      return fail(reply, 409, "NOT_INITIALISED", error.message);
    }
    if (error instanceof InvalidShareError) {
      return fail(reply, 400, "INVALID_SHARE", error.message);
    }
    if (error instanceof UnsealFailedError) {
      return fail(reply, 400, "UNSEAL_FAILED", error.message);
    }
    if (error instanceof AuditUnavailableError) {
      return fail(
        reply,
        503,
        "AUDIT_UNAVAILABLE",
        "The audit log is unavailable, so nothing was changed. Check the audit service (docs/runbook.md); to seal in an emergency, stop the secrets container.",
      );
    }
    if (error instanceof TooManyAttemptsError) {
      reply.header("retry-after", error.retryAfterSeconds);
      return fail(reply, 429, "TOO_MANY_ATTEMPTS", error.message);
    }
    const statusCode =
      error instanceof Error &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    if (statusCode < 500) {
      return fail(reply, 400, "BAD_REQUEST", "Invalid request");
    }
    return fail(reply, 500, "INTERNAL_ERROR", "Something went wrong");
  });

  app.get("/status", () => seal.status());

  app.post("/init", async (_request, reply) => {
    const result = await seal.initialise();
    return reply
      .code(201)
      .send({ ...result, shareCount: result.shares.length });
  });

  app.post<{ Body: { share?: unknown } }>("/unseal", async (request) => {
    const share = request.body?.share;
    if (typeof share !== "string") throw new InvalidShareError();
    return seal.submitShare(share);
  });

  app.post("/seal", async () => {
    await seal.seal();
    return seal.status();
  });

  return app;
}

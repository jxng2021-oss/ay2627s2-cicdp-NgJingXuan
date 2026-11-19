import type { FastifyRequest } from "fastify";
import type { Static, TSchema } from "typebox";
import type {
  UnwrapFileKeyBody,
  UnwrapSigningKeyBody,
  WrapFileKeyBody,
  WrapSigningKeyBody,
} from "../schemas.js";
import type { SecretService } from "../services/secret.service.js";

type Body<T extends TSchema> = { Body: Static<T> };

async function withZeroed<T>(
  key: Buffer,
  use: (key: Buffer) => T | Promise<T>,
): Promise<T> {
  try {
    return await use(key);
  } finally {
    key.fill(0);
  }
}

export function createKeyController(secrets: SecretService) {
  return {
    wrapFileKey: (request: FastifyRequest<Body<typeof WrapFileKeyBody>>) =>
      withZeroed(Buffer.from(request.body.key, "base64"), async (key) => ({
        wrappedKey: (
          await secrets.wrapFileKey(request.tenantId, request.body.fileId, key)
        ).toString("base64"),
      })),

    unwrapFileKey: async (
      request: FastifyRequest<Body<typeof UnwrapFileKeyBody>>,
    ) =>
      withZeroed(
        await secrets.unwrapFileKey(
          request.tenantId,
          request.body.fileId,
          Buffer.from(request.body.wrappedKey, "base64"),
        ),
        (key) => ({ key: key.toString("base64") }),
      ),

    wrapSigningKey: (
      request: FastifyRequest<Body<typeof WrapSigningKeyBody>>,
    ) =>
      withZeroed(Buffer.from(request.body.key, "base64"), async (key) => ({
        wrappedKey: (
          await secrets.wrapSigningKey(
            request.tenantId,
            request.body.poolId,
            key,
          )
        ).toString("base64"),
      })),

    unwrapSigningKey: async (
      request: FastifyRequest<Body<typeof UnwrapSigningKeyBody>>,
    ) =>
      withZeroed(
        await secrets.unwrapSigningKey(
          request.tenantId,
          request.body.poolId,
          Buffer.from(request.body.wrappedKey, "base64"),
        ),
        (key) => ({ key: key.toString("base64") }),
      ),
  };
}

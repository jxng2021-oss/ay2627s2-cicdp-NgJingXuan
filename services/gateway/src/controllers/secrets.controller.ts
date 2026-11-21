import type {
  deleteSecretSchema,
  listSecretsSchema,
  listVersionsSchema,
  putSecretSchema,
  readSecretSchema,
  rotateSecretSchema,
} from "../api/secrets-schemas.js";
import {
  secretPath,
  type SecretsForwarder,
} from "../services/secrets.service.js";
import type { Rep, Req } from "../types.js";

export function createSecretsController({
  forward,
  forwardValue,
}: SecretsForwarder) {
  return {
    list: (
      request: Req<typeof listSecretsSchema>,
      reply: Rep<typeof listSecretsSchema>,
    ) =>
      forward(request, reply, "GET", "/secrets", {
        limit: request.query.limit,
        cursor: request.query.cursor,
      }),

    put: (
      request: Req<typeof putSecretSchema>,
      reply: Rep<typeof putSecretSchema>,
    ) =>
      forwardValue(
        request,
        reply,
        "PUT",
        secretPath(request.params.name),
        request.body.value,
      ),

    read: (
      request: Req<typeof readSecretSchema>,
      reply: Rep<typeof readSecretSchema>,
    ) =>
      forward(request, reply, "GET", secretPath(request.params.name), {
        version: request.query.version,
      }),

    versions: (
      request: Req<typeof listVersionsSchema>,
      reply: Rep<typeof listVersionsSchema>,
    ) =>
      forward(
        request,
        reply,
        "GET",
        `${secretPath(request.params.name)}/versions`,
        { limit: request.query.limit, cursor: request.query.cursor },
      ),

    rotate: (
      request: Req<typeof rotateSecretSchema>,
      reply: Rep<typeof rotateSecretSchema>,
    ) =>
      forwardValue(
        request,
        reply,
        "POST",
        `${secretPath(request.params.name)}/rotate`,
        request.body.value,
      ),

    remove: (
      request: Req<typeof deleteSecretSchema>,
      reply: Rep<typeof deleteSecretSchema>,
    ) => forward(request, reply, "DELETE", secretPath(request.params.name)),
  };
}

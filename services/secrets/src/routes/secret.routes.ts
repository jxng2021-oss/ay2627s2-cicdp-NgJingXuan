import type { FastifyInstance } from "fastify";
import type { createKeyController } from "../controllers/key.controller.js";
import type { createSecretController } from "../controllers/secret.controller.js";
import {
  ListQuery,
  NameParams,
  UnwrapFileKeyBody,
  UnwrapSigningKeyBody,
  ValueBody,
  VersionQuery,
  VersionsQuery,
  WrapFileKeyBody,
  WrapSigningKeyBody,
} from "../schemas.js";

export function secretRoutes(
  app: FastifyInstance,
  secrets: ReturnType<typeof createSecretController>,
  keys: ReturnType<typeof createKeyController>,
): void {
  app.get("/secrets", { schema: { querystring: ListQuery } }, secrets.list);
  app.put(
    "/secrets/:name",
    { schema: { params: NameParams, body: ValueBody } },
    secrets.save,
  );
  app.post(
    "/secrets/:name/rotate",
    { schema: { params: NameParams, body: ValueBody } },
    secrets.rotate,
  );
  app.get(
    "/secrets/:name",
    { schema: { params: NameParams, querystring: VersionQuery } },
    secrets.describe,
  );
  app.get(
    "/secrets/:name/versions",
    { schema: { params: NameParams, querystring: VersionsQuery } },
    secrets.versions,
  );
  app.delete(
    "/secrets/:name",
    { schema: { params: NameParams } },
    secrets.remove,
  );

  app.post(
    "/internal/file-keys/wrap",
    { schema: { body: WrapFileKeyBody } },
    keys.wrapFileKey,
  );
  app.post(
    "/internal/file-keys/unwrap",
    { schema: { body: UnwrapFileKeyBody } },
    keys.unwrapFileKey,
  );
  app.post(
    "/internal/signing-keys/wrap",
    { schema: { body: WrapSigningKeyBody } },
    keys.wrapSigningKey,
  );
  app.post(
    "/internal/signing-keys/unwrap",
    { schema: { body: UnwrapSigningKeyBody } },
    keys.unwrapSigningKey,
  );
  app.delete("/internal/tenant", secrets.shredTenant);
  app.get(
    "/internal/secrets/:name",
    { schema: { params: NameParams } },
    secrets.readForInjection,
  );
}

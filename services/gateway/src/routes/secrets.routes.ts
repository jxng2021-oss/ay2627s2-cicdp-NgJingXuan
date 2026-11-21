import type { FastifyPluginCallback } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import {
  deleteSecretSchema,
  listSecretsSchema,
  listVersionsSchema,
  putSecretSchema,
  readSecretSchema,
  rotateSecretSchema,
} from "../api/secrets-schemas.js";
import { createSecretsController } from "../controllers/secrets.controller.js";
import {
  secretsForwarder,
  type SecretsProxyOptions,
} from "../services/secrets.service.js";
import { strictValidatorCompiler } from "../validation.js";

export const secretsProxy: FastifyPluginCallback<SecretsProxyOptions> = (
  app,
  options,
  done,
) => {
  const secrets = secretsForwarder(options);
  app.addHook("onClose", secrets.close);
  app.setValidatorCompiler(strictValidatorCompiler);
  app.removeContentTypeParser("text/plain");
  const bodyLimit = options.maxSecretBytes * 6 + 1024;
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("cache-control", "no-store");
  });

  const c = createSecretsController(secrets);
  const api = app.withTypeProvider<TypeBoxTypeProvider>();
  api.get("/secrets", { schema: listSecretsSchema }, c.list);
  api.put("/secrets/:name", { schema: putSecretSchema, bodyLimit }, c.put);
  api.get("/secrets/:name", { schema: readSecretSchema }, c.read);
  api.get(
    "/secrets/:name/versions",
    { schema: listVersionsSchema },
    c.versions,
  );
  api.post(
    "/secrets/:name/rotate",
    { schema: rotateSecretSchema, bodyLimit },
    c.rotate,
  );
  api.delete("/secrets/:name", { schema: deleteSecretSchema }, c.remove);
  done();
};

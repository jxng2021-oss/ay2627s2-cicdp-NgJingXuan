import type { FastifyPluginCallback } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { evaluateFlagsSchema } from "../api/flag-schemas.js";
import { createFlagsController } from "../controllers/flags.controller.js";
import {
  flagsForwarder,
  type FlagsOptions,
} from "../services/flags.service.js";
import { strictValidatorCompiler } from "../validation.js";

export const flagRoutes: FastifyPluginCallback<FlagsOptions> = (
  app,
  options,
  done,
) => {
  const flags = flagsForwarder(options);
  app.addHook("onClose", flags.close);
  app.setValidatorCompiler(strictValidatorCompiler);
  app.removeContentTypeParser("text/plain");
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("cache-control", "no-store");
  });
  const c = createFlagsController(flags);
  app
    .withTypeProvider<TypeBoxTypeProvider>()
    .post(
      "/flags/evaluate",
      { schema: evaluateFlagsSchema, bodyLimit: 64 * 1024 },
      c.evaluate,
    );
  done();
};

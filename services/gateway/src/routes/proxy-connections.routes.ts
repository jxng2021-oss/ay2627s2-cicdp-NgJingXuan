import type { FastifyPluginCallback } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import {
  connectionUsageSchema,
  deleteConnectionSchema,
  listConnectionsSchema,
  putConnectionSchema,
} from "../api/proxy-schemas.js";
import { createProxyConnectionsController } from "../controllers/proxy-connections.controller.js";
import type { ProxyConnectionOptions } from "../services/connection.service.js";
import { strictValidatorCompiler } from "../validation.js";

export const proxyConnectionRoutes: FastifyPluginCallback<
  ProxyConnectionOptions
> = (app, options, done) => {
  app.setValidatorCompiler(strictValidatorCompiler);
  app.removeContentTypeParser("text/plain");
  const c = createProxyConnectionsController(options);
  const api = app.withTypeProvider<TypeBoxTypeProvider>();
  api.put("/proxy-connections/:name", { schema: putConnectionSchema }, c.put);
  api.get("/proxy-connections", { schema: listConnectionsSchema }, c.list);
  api.get(
    "/proxy-connections/:name/usage",
    { schema: connectionUsageSchema },
    c.usage,
  );
  api.delete(
    "/proxy-connections/:name",
    { schema: deleteConnectionSchema },
    c.remove,
  );
  done();
};

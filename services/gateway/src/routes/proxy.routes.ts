import type { FastifyPluginCallback } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { proxySchema } from "../api/proxy-schemas.js";
import { createProxyController } from "../controllers/proxy.controller.js";
import { apiKeyEvent } from "../services/audit-event.service.js";
import {
  createProxyService,
  type ProxyRouteOptions,
} from "../services/proxy.service.js";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

export const proxyRoute: FastifyPluginCallback<ProxyRouteOptions> = (
  app,
  options,
  done,
) => {
  const proxy = createProxyService(options);
  app.addHook("onClose", proxy.close);

  app.decorateRequest("proxyConnectionName", undefined);
  app.decorateRequest("proxyOutcome", "failure");
  app.addHook("onResponse", (request, _reply, hookDone) => {
    const name = request.proxyConnectionName;
    if (name !== undefined) {
      const outcome = request.proxyOutcome;
      void options.audit.recordBestEffort(
        outcome === "policy_denied"
          ? apiKeyEvent(request, "proxy_connection.denied", name, "denied")
          : apiKeyEvent(request, "proxy_connection.used", name, outcome),
        request.log,
      );
    }
    hookDone();
  });

  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", (_request, _payload, parserDone) => {
    parserDone(null);
  });

  const c = createProxyController(options, proxy);
  app.withTypeProvider<TypeBoxTypeProvider>().route({
    method: METHODS,
    url: "/proxy/:connection/*",
    schema: proxySchema,
    handler: c.handle,
  });

  done();
};

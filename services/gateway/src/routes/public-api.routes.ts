import type { FastifyPluginCallback } from "fastify";
import {
  addApiKeyAuthentication,
  type ApiKeyAuthOptions,
} from "../middleware/api-key-auth.js";
import type { AuditClient } from "../audit.js";
import type { ProxyPolicy, Resolver } from "../services/ssrf.service.js";
import type { RateLimitStore } from "../rate-limit.js";
import { auditEventsRoute } from "./audit-events.routes.js";
import { proxyConnectionRoutes } from "./proxy-connections.routes.js";
import { proxyRoute } from "./proxy.routes.js";
import type { SecretsProxyOptions } from "../services/secrets.service.js";
import { secretsProxy } from "./secrets.routes.js";
import type { StorageProxyOptions } from "../services/storage.service.js";
import { storageProxy } from "./storage.routes.js";
import { flagRoutes } from "./flags.routes.js";
import { userPoolRoutes } from "./user-pools.routes.js";
import { webhookEventsRoute } from "./webhooks.routes.js";
import type { WebhooksControllerOptions } from "../controllers/webhooks.controller.js";

export type PublicApiOptions = ApiKeyAuthOptions &
  StorageProxyOptions &
  SecretsProxyOptions & {
    proxy: ProxyPolicy;
    resolver: Resolver;
    audit: AuditClient;
    auditUrl: string;
    auditToken: string;
    identityUrl: string;
    flagsUrl: string;
    rateLimitStore: RateLimitStore;
    webhooks: WebhooksControllerOptions;
  };

export const publicApiV1: FastifyPluginCallback<PublicApiOptions> = (
  app,
  options,
  done,
) => {
  addApiKeyAuthentication(app, options);

  const upstream = {
    connectTimeoutMs: options.connectTimeoutMs,
    responseTimeoutMs: options.responseTimeoutMs,
  };
  app.register(storageProxy, {
    ...upstream,
    storageUrl: options.storageUrl,
    maxUploadBytes: options.maxUploadBytes,
  });
  app.register(secretsProxy, {
    ...upstream,
    secretsUrl: options.secretsUrl,
    maxSecretBytes: options.maxSecretBytes,
  });
  app.register(proxyConnectionRoutes, {
    db: options.db,
    policy: options.proxy,
    audit: options.audit,
    rateLimitStore: options.rateLimitStore,
  });
  app.register(proxyRoute, {
    ...upstream,
    db: options.db,
    policy: options.proxy,
    resolver: options.resolver,
    secretsUrl: options.secretsUrl,
    maxUploadBytes: options.maxUploadBytes,
    audit: options.audit,
    rateLimitStore: options.rateLimitStore,
  });
  app.register(userPoolRoutes, {
    ...upstream,
    identityUrl: options.identityUrl,
  });
  app.register(flagRoutes, { ...upstream, flagsUrl: options.flagsUrl });
  app.register(webhookEventsRoute, options.webhooks);
  app.register(auditEventsRoute, {
    ...upstream,
    auditUrl: options.auditUrl,
    auditToken: options.auditToken,
  });
  done();
};

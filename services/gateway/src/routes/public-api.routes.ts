import type { FastifyPluginCallback } from "fastify";
import {
  addApiKeyAuthentication,
  type ApiKeyAuthOptions,
} from "../middleware/api-key-auth.js";
import type { SecretsProxyOptions } from "../services/secrets.service.js";
import { secretsProxy } from "./secrets.routes.js";
import type { StorageProxyOptions } from "../services/storage.service.js";
import { storageProxy } from "./storage.routes.js";

export type PublicApiOptions = ApiKeyAuthOptions &
  StorageProxyOptions &
  SecretsProxyOptions;

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
  done();
};

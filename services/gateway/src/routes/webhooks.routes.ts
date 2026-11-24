import type { FastifyPluginCallback } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import {
  listWebhookEventsSchema,
  receiveWebhookSchema,
  webhookKeysSchema,
} from "../api/webhook-schemas.js";
import {
  webhooksController,
  type WebhooksControllerOptions,
} from "../controllers/webhooks.controller.js";
import { MAX_WEBHOOK_BYTES } from "../services/webhook.service.js";

export const webhookPublicRoutes: FastifyPluginCallback<
  WebhooksControllerOptions
> = (app, options, done) => {
  const c = webhooksController(options);
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    "*",
    { parseAs: "buffer", bodyLimit: MAX_WEBHOOK_BYTES },
    (_request, body, parsed) => parsed(null, body),
  );
  const api = app.withTypeProvider<TypeBoxTypeProvider>();
  api.get("/webhooks/keys", { schema: webhookKeysSchema }, c.keys);
  api.post(
    "/webhooks/:endpointId",
    { schema: receiveWebhookSchema },
    c.receive,
  );
  done();
};

export const webhookEventsRoute: FastifyPluginCallback<
  WebhooksControllerOptions
> = (app, options, done) => {
  const c = webhooksController(options);
  app
    .withTypeProvider<TypeBoxTypeProvider>()
    .get("/webhook-events", { schema: listWebhookEventsSchema }, c.pull);
  done();
};

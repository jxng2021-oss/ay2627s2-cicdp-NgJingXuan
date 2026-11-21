import type { FastifyInstance, FastifyPluginCallback } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import {
  deleteFileSchema,
  downloadFileSchema,
  fileMetadataSchema,
  listFilesSchema,
  uploadFileSchema,
  usageSchema,
} from "../api/schemas.js";
import { createStorageController } from "../controllers/storage.controller.js";
import {
  storageForwarder,
  type StorageProxyOptions,
} from "../services/storage.service.js";

export function streamBodies(app: FastifyInstance): void {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", (_request, _payload, parserDone) => {
    parserDone(null);
  });
}

export const storageProxy: FastifyPluginCallback<StorageProxyOptions> = (
  app,
  options,
  done,
) => {
  const storage = storageForwarder(options);
  app.addHook("onClose", storage.close);
  streamBodies(app);
  const c = createStorageController(storage);
  const api = app.withTypeProvider<TypeBoxTypeProvider>();
  api.post("/storage/files", { schema: uploadFileSchema }, c.upload);
  api.get("/storage/files", { schema: listFilesSchema }, c.list);
  api.get("/storage/usage", { schema: usageSchema }, c.usage);
  api.get("/storage/files/:id", { schema: downloadFileSchema }, c.download);
  api.get(
    "/storage/files/:id/metadata",
    { schema: fileMetadataSchema },
    c.metadata,
  );
  api.delete("/storage/files/:id", { schema: deleteFileSchema }, c.remove);
  done();
};

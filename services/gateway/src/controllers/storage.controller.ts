import type {
  deleteFileSchema,
  downloadFileSchema,
  fileMetadataSchema,
  listFilesSchema,
  uploadFileSchema,
  usageSchema,
} from "../api/schemas.js";
import type { StorageForwarder } from "../services/storage.service.js";
import type { Rep, Req } from "../types.js";

export function createStorageController({ forward }: StorageForwarder) {
  return {
    upload: (
      request: Req<typeof uploadFileSchema>,
      reply: Rep<typeof uploadFileSchema>,
    ) => forward(request, reply, "POST", "/files", true),

    list: (
      request: Req<typeof listFilesSchema>,
      reply: Rep<typeof listFilesSchema>,
    ) => {
      const query = new URLSearchParams();
      if (request.query.limit !== undefined)
        query.set("limit", String(request.query.limit));
      if (request.query.cursor !== undefined)
        query.set("cursor", request.query.cursor);
      const search = query.size > 0 ? `?${query.toString()}` : "";
      return forward(request, reply, "GET", `/files${search}`, false);
    },

    usage: (request: Req<typeof usageSchema>, reply: Rep<typeof usageSchema>) =>
      forward(request, reply, "GET", "/usage", false),

    download: (
      request: Req<typeof downloadFileSchema>,
      reply: Rep<typeof downloadFileSchema>,
    ) => forward(request, reply, "GET", `/files/${request.params.id}`, false),

    metadata: (
      request: Req<typeof fileMetadataSchema>,
      reply: Rep<typeof fileMetadataSchema>,
    ) =>
      forward(
        request,
        reply,
        "GET",
        `/files/${request.params.id}/metadata`,
        false,
      ),

    remove: (
      request: Req<typeof deleteFileSchema>,
      reply: Rep<typeof deleteFileSchema>,
    ) =>
      forward(request, reply, "DELETE", `/files/${request.params.id}`, false),
  };
}

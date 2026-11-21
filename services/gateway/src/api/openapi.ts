import type { FastifyDynamicSwaggerOptions } from "@fastify/swagger";

export const API_VERSION = "1.2.0";

function onlyUnder(prefix: string, keep: boolean) {
  return ({ schema, url }: { schema: object; url: string }) => ({
    schema:
      url.startsWith(prefix) === keep ? schema : { ...schema, hide: true },
    url,
  });
}

export const openApiOptions: FastifyDynamicSwaggerOptions = {
  openapi: {
    openapi: "3.0.3",
    info: {
      title: "Secure Cloud Platform API",
      version: API_VERSION,
      description: [
        "Store files and encrypted secrets, with an API key.",
        "",
        "- **Authentication:** send your key as `Authorization: Bearer <key>`.",
        "- **Versioning:** the version is in the URL (`/v1/...`). Within v1, changes are",
        "  only ever additions; anything breaking would get a new version (`/v2/...`).",
        "- **Rate limits:** per API key; see the `RateLimit-*` headers and `429` responses.",
        '- **Errors:** every error is `{ "error": { "code", "message", "requestId" } }`',
        "  with a stable `code`.",
      ].join("\n"),
    },
    tags: [
      { name: "Files", description: "Upload and download files" },
      {
        name: "Secrets",
        description:
          "Store encrypted secrets (passwords, tokens, keys) and read them back. Every save is a new version.",
      },
      {
        name: "Proxy",
        description:
          "Call an outside API with one of your stored secrets added, without the secret ever reaching you.",
      },
      {
        name: "Audit",
        description:
          "Your tamper-evident audit log: who did what to your keys, secrets, files and proxy connections, and when.",
      },
      { name: "Status", description: "Health and readiness" },
    ],
    components: {
      securitySchemes: {
        apiKey: {
          type: "http",
          scheme: "bearer",
          description:
            "An API key, e.g. `sk_live_3f9a0c1e7b2d4a68_...`, sent as `Authorization: Bearer <key>`.",
        },
      },
    },
  },
  hideUntagged: true,
  transform: onlyUnder("/dashboard/", false),
  transformObject: (documentObject) =>
    "openapiObject" in documentObject
      ? markRequiredHeaders(documentObject.openapiObject)
      : documentObject.swaggerObject,
};

interface ResponseHeaders {
  headers?: Record<string, { required?: boolean; schema?: object }>;
}
interface Paths {
  paths?: Record<string, Record<string, { responses?: object } | undefined>>;
}

function markRequiredHeaders<T extends object>(document: T): T {
  for (const operations of Object.values((document as Paths).paths ?? {})) {
    for (const operation of Object.values(operations)) {
      for (const response of Object.values(operation?.responses ?? {})) {
        const { headers } = response as ResponseHeaders;
        for (const header of Object.values(headers ?? {})) {
          const schema = header.schema as Record<string, unknown> | undefined;
          if (schema?.["x-required"] === true) {
            delete schema["x-required"];
            header.required = true;
          }
        }
      }
    }
  }
  return document;
}

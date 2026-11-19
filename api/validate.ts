import { readFileSync } from "node:fs";
import { Ajv, type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";

const addFormats = addFormatsModule.default;

interface MediaType {
  schema?: object;
}
interface Header {
  required?: boolean;
  schema?: object;
}
interface Response {
  headers?: Record<string, Header>;
  content?: Record<string, MediaType>;
}
interface Parameter {
  name: string;
  in: "path" | "header" | "query";
  required?: boolean;
  schema?: object;
}
interface Operation {
  parameters?: Parameter[];
  requestBody?: { required?: boolean; content?: Record<string, MediaType> };
  responses: Record<string, Response>;
}
export interface OpenApiDocument {
  paths: Record<string, Record<string, Operation>>;
}

const REPO_ROOT = new URL("../", import.meta.url);

export function loadSpec(pathFromRepoRoot: string): OpenApiDocument {
  return JSON.parse(
    readFileSync(new URL(pathFromRepoRoot, REPO_ROOT), "utf8"),
  ) as OpenApiDocument;
}

export class Contract {
  private readonly exact = new Ajv({ strict: false, allErrors: true });
  private readonly converting = new Ajv({
    strict: false,
    allErrors: true,
    coerceTypes: true,
  });
  private readonly compiled = new Map<Ajv, Map<object, ValidateFunction>>();

  constructor(private readonly spec: OpenApiDocument) {
    for (const ajv of [this.exact, this.converting]) {
      addFormats(ajv);
      ajv.addFormat("binary", true);
      ajv.addSchema(spec, "spec");
      this.compiled.set(ajv, new Map());
    }
  }

  operation(
    method: string,
    path: string,
  ): {
    template: string;
    operation: Operation;
    pathParams: Record<string, string>;
  } {
    const pathOnly = path.split("?")[0] ?? path;
    for (const [template, operations] of Object.entries(this.spec.paths)) {
      const names: string[] = [];
      const pattern = new RegExp(
        `^${template.replace(/\{([^}]+)\}/g, (_match, name: string) => {
          names.push(name);
          return name === "*" ? "(.*)" : "([^/]+)";
        })}$`,
      );
      const operation = operations[method.toLowerCase()];
      const match = pattern.exec(pathOnly);
      if (operation && match) {
        const pathParams: Record<string, string> = {};
        names.forEach((name, i) => {
          pathParams[name] = safeDecode(match[i + 1] ?? "");
        });
        return { template, operation, pathParams };
      }
    }
    throw new Error(`${method} ${pathOnly} is not in the contract`);
  }

  checkResponse(
    method: string,
    path: string,
    response: {
      statusCode: number;
      headers: Record<string, unknown>;
      body: string;
    },
  ): string[] {
    const { template, operation } = this.operation(method, path);
    const where = `${method.toUpperCase()} ${template} -> ${response.statusCode}`;
    const documented =
      operation.responses[String(response.statusCode)] ??
      operation.responses.default;
    if (!documented)
      return [`${where}: status ${response.statusCode} is not documented`];

    const problems: string[] = [];
    for (const [name, header] of Object.entries(documented.headers ?? {})) {
      if (!header.required) continue;
      const value = response.headers[name.toLowerCase()];
      if (value === undefined) {
        problems.push(`${where}: missing header ${name}`);
      } else if (header.schema) {
        problems.push(
          ...this.check(
            this.converting,
            header.schema,
            value,
            `${where} header ${name}`,
          ),
        );
      }
    }
    return [
      ...problems,
      ...this.checkBody(where, documented.content ?? {}, response),
    ];
  }

  checkRequest(
    method: string,
    url: string,
    headers: Record<string, unknown>,
    body?: string,
  ): string[] {
    const { template, operation, pathParams } = this.operation(method, url);
    const where = `${method.toUpperCase()} ${template}`;
    const query = new URLSearchParams(url.split("?")[1] ?? "");
    const parameters = operation.parameters ?? [];
    const problems: string[] = [];

    for (const parameter of parameters) {
      const value =
        parameter.in === "header"
          ? headers[parameter.name.toLowerCase()]
          : parameter.in === "path"
            ? pathParams[parameter.name]
            : (query.get(parameter.name) ?? undefined);
      if (value === undefined) {
        if (parameter.required) {
          problems.push(
            `${where}: missing ${parameter.in} parameter ${parameter.name}`,
          );
        }
      } else if (parameter.schema) {
        problems.push(
          ...this.check(
            this.converting,
            parameter.schema,
            value,
            `${where} ${parameter.in} parameter ${parameter.name}`,
          ),
        );
      }
    }
    for (const name of query.keys()) {
      if (!parameters.some((p) => p.in === "query" && p.name === name)) {
        problems.push(`${where}: undocumented query parameter ${name}`);
      }
    }

    const jsonBody = operation.requestBody?.content?.["application/json"];
    if (jsonBody?.schema) {
      if (body === undefined || body === "") {
        if (operation.requestBody?.required) {
          problems.push(`${where}: missing request body`);
        }
      } else {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          return [...problems, `${where}: request body is not valid JSON`];
        }
        problems.push(
          ...this.check(
            this.exact,
            jsonBody.schema,
            parsed,
            `${where} request body`,
          ),
        );
      }
    }
    return problems;
  }

  private checkBody(
    where: string,
    media: Record<string, MediaType>,
    response: { headers: Record<string, unknown>; body: string },
  ): string[] {
    if (Object.keys(media).length === 0) return [];
    const header = response.headers["content-type"];
    const contentType = typeof header === "string" ? header.split(";")[0] : "";
    const expected = contentType ? media[contentType] : undefined;
    if (!expected) {
      return [
        `${where}: content type "${contentType}" not documented (expected ${Object.keys(media).join(", ")})`,
      ];
    }
    if (contentType !== "application/json" || !expected.schema) return [];

    let body: unknown;
    try {
      body = JSON.parse(response.body);
    } catch {
      return [`${where}: body is not valid JSON`];
    }
    return this.check(this.exact, expected.schema, body, `${where} body`);
  }

  private check(
    ajv: Ajv,
    schema: object,
    value: unknown,
    where: string,
  ): string[] {
    const cache = this.compiled.get(ajv);
    let validate = cache?.get(schema);
    if (!validate) {
      const resolved = JSON.parse(
        JSON.stringify(schema).replaceAll('"$ref":"#/', '"$ref":"spec#/'),
      ) as object;
      validate = ajv.compile(resolved);
      cache?.set(schema, validate);
    }
    if (validate(value)) return [];
    return (validate.errors ?? []).map(
      (e) =>
        `${where}: ${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`,
    );
  }
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

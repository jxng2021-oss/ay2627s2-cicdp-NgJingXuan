import { Ajv } from "ajv";
import type { FastifySchemaCompiler } from "fastify";

const strictBodies = new Ajv({
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: false,
  allErrors: false,
  keywords: ["example"],
});

const queryAndParams = new Ajv({
  coerceTypes: "array",
  removeAdditional: false,
  useDefaults: true,
  allErrors: false,
  keywords: ["example"],
});

export const strictValidatorCompiler: FastifySchemaCompiler<object> = ({
  schema,
  httpPart,
}) => (httpPart === "body" ? strictBodies : queryAndParams).compile(schema);

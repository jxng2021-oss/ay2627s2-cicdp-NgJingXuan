import type { IncomingMessage } from "node:http";
import type { LightMyRequestResponse } from "fastify";
import { expect } from "vitest";
import { Contract, loadSpec } from "../../api/validate.js";
import { startFakeStorage } from "./helpers.js";

export const publicContract = new Contract(loadSpec("api/openapi.v1.json"));
export const storageContract = new Contract(
  loadSpec("api/internal/storage.openapi.json"),
);
export const secretsContract = new Contract(
  loadSpec("api/internal/secrets.openapi.json"),
);
export const auditContract = new Contract(
  loadSpec("api/internal/audit.openapi.json"),
);
export const identityContract = new Contract(
  loadSpec("api/internal/identity.openapi.json"),
);
export const flagsContract = new Contract(
  loadSpec("api/internal/flags.openapi.json"),
);

export function expectPublicContract(
  method: string,
  url: string,
  response: LightMyRequestResponse,
): void {
  expect(
    publicContract.checkResponse(method, url, {
      statusCode: response.statusCode,
      headers: response.headers,
      body: response.body,
    }),
  ).toEqual([]);
}

export interface ServiceReply {
  status: number;
  contentType?: string;
  body?: Buffer | string;
  headers?: Record<string, string>;
}
export type StorageReply = ServiceReply;

export interface ReceivedRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

export async function startContractService(
  contract: Contract,
  reply: (request: ReceivedRequest) => ServiceReply,
  allowedAuthorization?: string,
) {
  const problems: string[] = [];
  const requests: ReceivedRequest[] = [];
  const url = await startFakeStorage((req, res) => {
    const method = req.method ?? "GET";
    const path = req.url ?? "/";
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const received: ReceivedRequest = {
        method,
        url: path,
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      requests.push(received);
      const isJson = String(req.headers["content-type"]).startsWith(
        "application/json",
      );
      problems.push(
        ...contract.checkRequest(
          method,
          path,
          req.headers,
          isJson ? received.body.toString("utf8") : undefined,
        ),
      );
      if (
        req.headers.authorization !== undefined &&
        req.headers.authorization !== allowedAuthorization
      ) {
        problems.push(`${method} ${path}: the API key was sent on`);
      }

      const answer = reply(received);
      const headers: Record<string, string> = { ...answer.headers };
      if (answer.contentType) headers["content-type"] = answer.contentType;
      problems.push(
        ...contract.checkResponse(method, path, {
          statusCode: answer.status,
          headers,
          body: answer.body?.toString() ?? "",
        }),
      );
      res.writeHead(answer.status, headers);
      res.end(answer.body);
    });
  });
  return { url, problems, requests };
}

export function startContractStorage(
  reply: (request: ReceivedRequest, body: Buffer) => ServiceReply,
) {
  return startContractService(storageContract, (received) =>
    reply(received, received.body),
  );
}

export function serviceError(
  request: { headers: IncomingMessage["headers"] },
  status: number,
  code: string,
  headers: Record<string, string> = {},
): ServiceReply {
  return {
    status,
    contentType: "application/json; charset=utf-8",
    headers,
    body: JSON.stringify({
      error: {
        code,
        message: `service said ${code}`,
        requestId: request.headers["x-request-id"],
      },
    }),
  };
}

export const storageError = (
  request: { headers: IncomingMessage["headers"] },
  status: number,
  code: string,
) => serviceError(request, status, code);

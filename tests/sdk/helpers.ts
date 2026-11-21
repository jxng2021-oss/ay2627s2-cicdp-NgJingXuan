import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach } from "vitest";

export interface Seen {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

type Handler = (req: Seen, res: ServerResponse) => unknown;

const servers: { close(): void }[] = [];
afterEach(() => {
  while (servers.length) servers.pop()!.close();
});

export async function fakeGateway(handler: Handler) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const request: Seen = {
        method: req.method ?? "GET",
        path: req.url ?? "/",
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      seen.push(request);
      void Promise.resolve(handler(request, res)).catch(() => {
        res.statusCode = 500;
        res.end();
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen };
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

export function platformError(
  res: ServerResponse,
  status: number,
  code: string,
  message = code,
): void {
  json(res, status, {
    error: { code, message, requestId: "7c41e9d2-0000-4000-8000-000000000000" },
  });
}

export const API_KEY = "sk_local_fake-key-for-the-sdk-tests-only";
export const POOL_ID = "8b9e3c1a-2d4f-4a6b-9c8d-1e2f3a4b5c6d";
export const FILE_ID = "3f2c9b1e-6a4d-4c8e-9f1a-2b3c4d5e6f70";

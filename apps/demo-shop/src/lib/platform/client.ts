import { Readable } from "node:stream";
import {
  SecureCloud,
  SecureCloudError,
  type FileInfo,
} from "@secure-cloud/sdk";
import type { paths } from "./schema";

type Ok<
  P extends keyof paths,
  M extends "get" | "post",
  S extends number,
> = paths[P][M] extends {
  responses: Record<S, { content: { "application/json": infer T } }>;
}
  ? T
  : never;

export type { FileInfo };
export type Usage = Ok<"/v1/storage/usage", "get", 200>;
export type SecretSummary = Ok<"/v1/secrets", "get", 200>["secrets"][number];
export type Connection = Ok<
  "/v1/proxy-connections",
  "get",
  200
>["connections"][number];
export type AuditPage = Ok<"/v1/audit-events", "get", 200>;
export type AuditEvent = AuditPage["events"][number];

export { SecureCloudError as PlatformError };
const PlatformError = SecureCloudError;

export function platformSettings(): { url: string; key: string } | null {
  const key = process.env.PLATFORM_API_KEY;
  if (!key) return null;
  return {
    url: (process.env.PLATFORM_API_URL ?? "http://127.0.0.1:8080").replace(
      /\/$/,
      "",
    ),
    key,
  };
}

export function isConnected(): boolean {
  return platformSettings() !== null;
}

let client: { cloud: SecureCloud; for: string } | undefined;

function cloud(): SecureCloud {
  const settings = platformSettings();
  if (!settings) {
    throw new PlatformError(
      0,
      "NOT_CONNECTED",
      "The shop isn't connected to the platform yet.",
    );
  }
  const key = `${settings.url} ${settings.key}`;
  if (client?.for !== key) {
    client = {
      cloud: new SecureCloud({ apiKey: settings.key, url: settings.url }),
      for: key,
    };
  }
  return client.cloud;
}

export async function errorFrom(response: Response): Promise<SecureCloudError> {
  const requestId = response.headers.get("x-request-id") ?? undefined;
  try {
    const body = (await response.json()) as {
      error?: { code?: unknown; message?: unknown; requestId?: unknown };
    };
    const error = body.error;
    if (typeof error?.code === "string" && typeof error.message === "string") {
      return new PlatformError(
        response.status,
        error.code,
        error.message,
        typeof error.requestId === "string" ? error.requestId : requestId,
      );
    }
  } catch {}
  return new PlatformError(
    response.status,
    "UNEXPECTED_RESPONSE",
    `The platform answered ${response.status}.`,
    requestId,
  );
}

type Init = Omit<RequestInit, "headers"> & {
  headers?: Record<string, string>;
  duplex?: "half";
};

async function send(path: string, init: Init = {}): Promise<Response> {
  const settings = platformSettings();
  if (!settings) {
    throw new PlatformError(
      0,
      "NOT_CONNECTED",
      "The shop isn't connected to the platform yet.",
    );
  }
  try {
    return await fetch(`${settings.url}${path}`, {
      ...init,
      cache: "no-store",
      redirect: "manual",
      headers: { ...init.headers, authorization: `Bearer ${settings.key}` },
    });
  } catch {
    throw new PlatformError(
      0,
      "PLATFORM_UNREACHABLE",
      "Couldn't reach the platform. Check the gateway is running, then retry.",
    );
  }
}

async function call(path: string, init?: Init): Promise<Response> {
  const response = await send(path, init);
  if (!response.ok) throw await errorFrom(response);
  return response;
}

async function json<T>(path: string, init?: Init): Promise<T> {
  return (await (await call(path, init)).json()) as T;
}

export async function listFiles(): Promise<FileInfo[]> {
  return cloud().files.list();
}

export async function uploadFile(
  name: string,
  contentType: string,
  body: ReadableStream<Uint8Array> | string,
): Promise<FileInfo> {
  return cloud().files.upload(
    typeof body === "string" ? Buffer.from(body) : body,
    { name, contentType },
  );
}

export async function fileMetadata(id: string): Promise<FileInfo> {
  return cloud().files.get(id);
}

export async function fileBody(
  id: string,
): Promise<ReadableStream<Uint8Array>> {
  return Readable.toWeb(
    await cloud().files.stream(id),
  ) as ReadableStream<Uint8Array>;
}

export async function deleteFile(id: string): Promise<void> {
  return cloud().files.delete(id);
}

export function storageUsage(): Promise<Usage> {
  return json<Usage>("/v1/storage/usage");
}

export async function listSecrets(): Promise<SecretSummary[]> {
  const page: Ok<"/v1/secrets", "get", 200> = await json(
    "/v1/secrets?limit=100",
  );
  return page.secrets;
}

export async function viaConnection<T>(
  connection: string,
  route: string,
  body?: unknown,
) {
  return cloud().connections.call<T>(connection, route, body);
}

export async function listConnections(): Promise<Connection[]> {
  const page: Ok<"/v1/proxy-connections", "get", 200> = await json(
    "/v1/proxy-connections",
  );
  return page.connections;
}

export function auditEvents(filters: {
  action?: string;
  cursor?: string;
}): Promise<AuditPage> {
  const query = new URLSearchParams({ limit: "50" });
  if (filters.action) query.set("action", filters.action);
  if (filters.cursor) query.set("cursor", filters.cursor);
  return json<AuditPage>(`/v1/audit-events?${query}`);
}

export type ShopperTokens = Ok<"/v1/user-pools/{poolId}/sessions", "post", 200>;

export function shopperPool(): string | null {
  const pool = process.env.PLATFORM_POOL_ID;
  return pool && /^[0-9a-f-]{36}$/.test(pool) ? pool : null;
}

export function shoppers() {
  const pool = shopperPool();
  if (!pool) {
    throw new PlatformError(
      0,
      "NOT_CONNECTED",
      "The shop has no user pool yet. Run pnpm demo:setup.",
    );
  }
  return cloud().userPool(pool);
}

export async function signUpShopper(
  email: string,
  password: string,
): Promise<void> {
  await shoppers().signUp({ email, password });
}

export async function signInShopper(
  email: string,
  password: string,
): Promise<ShopperTokens> {
  return shoppers().signIn({ email, password });
}

export async function changeShopperPassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  await shoppers().changePassword(userId, { currentPassword, newPassword });
}

export async function refreshShopper(
  refreshToken: string,
): Promise<ShopperTokens> {
  return shoppers().refresh(refreshToken);
}

export async function signOutShopper(refreshToken: string): Promise<void> {
  return shoppers().signOut(refreshToken);
}

const jsonBody = (body: unknown): Init => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export type FlagValues = Ok<"/v1/flags/evaluate", "post", 200>["flags"];

export async function evaluateFlags(context: {
  key: string;
  attributes?: Record<string, string | number | boolean>;
}): Promise<FlagValues> {
  const environment =
    process.env.DEMO_FLAGS_ENVIRONMENT === "staging" ||
    process.env.DEMO_FLAGS_ENVIRONMENT === "development"
      ? process.env.DEMO_FLAGS_ENVIRONMENT
      : "production";
  const answer = await json<Ok<"/v1/flags/evaluate", "post", 200>>(
    "/v1/flags/evaluate",
    jsonBody({ environment, context }),
  );
  return answer.flags;
}

import { apiUrl } from "./origin";
import type { paths } from "./schema";

export const API_BASE = "/dashboard/v1";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | undefined,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class NetworkError extends ApiError {
  constructor() {
    super(
      0,
      "NETWORK_ERROR",
      "Couldn't reach the dashboard. Check your connection, then retry.",
      undefined,
    );
  }
}

type SessionListener = () => void;
const sessionEndedListeners = new Set<SessionListener>();

export function onSessionEnded(listener: SessionListener): () => void {
  sessionEndedListeners.add(listener);
  return () => sessionEndedListeners.delete(listener);
}

let csrfToken: string | undefined;

export function clearCsrfToken(): void {
  csrfToken = undefined;
}

const PUBLIC_PATHS = new Set([
  `${API_BASE}/auth/login`,
  `${API_BASE}/auth/sign-up`,
]);

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RequestOptions {
  json?: unknown;
  query?: Record<string, string | number | undefined>;
  signal?: AbortSignal;
}

export async function errorFrom(response: Response): Promise<ApiError> {
  const headerId = response.headers.get("x-request-id") ?? undefined;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const error = (
    body as
      | { error?: { code?: unknown; message?: unknown; requestId?: unknown } }
      | undefined
  )?.error;
  return new ApiError(
    response.status,
    typeof error?.code === "string" ? error.code : "UNKNOWN",
    typeof error?.message === "string"
      ? error.message
      : `The request failed (HTTP ${response.status}).`,
    typeof error?.requestId === "string" ? error.requestId : headerId,
  );
}

async function getCsrfToken(): Promise<string> {
  if (csrfToken) return csrfToken;
  const { csrfToken: token } = await request<{ csrfToken: string }>(
    "GET",
    `${API_BASE}/auth/csrf`,
  );
  csrfToken = token;
  return token;
}

export async function changeHeaders(
  path: string,
): Promise<Record<string, string>> {
  return PUBLIC_PATHS.has(path) ? {} : { "x-csrf-token": await getCsrfToken() };
}

export function reportStatus(path: string, status: number): void {
  if (status === 401 && !PUBLIC_PATHS.has(path)) {
    clearCsrfToken();
    for (const listener of sessionEndedListeners) listener();
  }
}

export async function request<T>(
  method: Method,
  path: string,
  options: RequestOptions = {},
  retried = false,
): Promise<T> {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== "") search.set(name, String(value));
  }
  const url = search.size > 0 ? `${path}?${search.toString()}` : path;
  const headers: Record<string, string> =
    method === "GET" ? {} : await changeHeaders(path);
  if (options.json !== undefined) headers["content-type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(apiUrl(url), {
      method,
      headers,
      credentials: "include",
      body:
        options.json === undefined ? undefined : JSON.stringify(options.json),
      signal: options.signal,
      cache: "no-store",
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw error;
    throw new NetworkError();
  }

  if (!response.ok) {
    const error = await errorFrom(response);
    if (response.status === 403 && /CSRF/.test(error.message) && !retried) {
      clearCsrfToken();
      return request<T>(method, path, options, true);
    }
    reportStatus(path, response.status);
    throw error;
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function uploadFile(
  path: string,
  file: File,
  onProgress: (fraction: number) => void,
): Promise<FileMetadata> {
  const headers = await changeHeaders(path);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", apiUrl(path));
    xhr.withCredentials = true;
    for (const [name, value] of Object.entries(headers))
      xhr.setRequestHeader(name, value);
    xhr.setRequestHeader(
      "content-type",
      file.type || "application/octet-stream",
    );
    xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onerror = () => reject(new NetworkError());
    xhr.onload = () => {
      const response = new Response(xhr.responseText || null, {
        status: xhr.status,
        headers: {
          "x-request-id": xhr.getResponseHeader("x-request-id") ?? "",
        },
      });
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(1);
        resolve(JSON.parse(xhr.responseText) as FileMetadata);
      } else {
        reportStatus(path, xhr.status);
        void errorFrom(response).then(reject);
      }
    };
    xhr.send(file);
  });
}

type Json<
  P extends keyof paths,
  M extends "get" | "post" | "put" | "delete",
  S extends number,
> = paths[P][M] extends {
  responses: Record<S, { content: { "application/json": infer B } }>;
}
  ? B
  : never;

type W = "/dashboard/v1/workspaces/{workspaceId}";
export type Me = Json<"/dashboard/v1/auth/me", "get", 200>;
export type WorkspaceSummary = Me["workspaces"][number];
export type SessionList = Json<"/dashboard/v1/account/sessions", "get", 200>;
export type SessionInfo = SessionList["sessions"][number];
export type Overview = Json<W, "get", 200>;
export type Analytics = Json<`${W}/analytics`, "get", 200>;
export type AnalyticsRange = Analytics["range"];
export type ApiKeyList = Json<`${W}/api-keys`, "get", 200>;
export type NewApiKey = Json<`${W}/api-keys`, "post", 201>;
export type SecretList = Json<`${W}/secrets`, "get", 200>;
export type SecretVersions = Json<`${W}/secrets/{name}/versions`, "get", 200>;
export type FileList = Json<`${W}/files`, "get", 200>;
export type FileMetadata = FileList["files"][number];
export type Usage = Json<`${W}/usage`, "get", 200>;
export type ConnectionList = Json<`${W}/proxy-connections`, "get", 200>;
export type Connection = ConnectionList["connections"][number];
export type ConnectionPolicy = NonNullable<Connection["policy"]>;
export type ConnectionUsage = Json<
  `${W}/proxy-connections/{name}/usage`,
  "get",
  200
>;
export type PoolList = Json<`${W}/user-pools`, "get", 200>;
export type Pool = PoolList["pools"][number];
export type NewPool = Json<`${W}/user-pools`, "post", 201>;
export type PoolUserList = Json<`${W}/user-pools/{poolId}/users`, "get", 200>;
export type PoolUser = PoolUserList["users"][number];
export type PoolRoleList = Json<`${W}/user-pools/{poolId}/roles`, "get", 200>;
export type PoolRole = PoolRoleList["roles"][number];
export type FlagList = Json<`${W}/flags`, "get", 200>;
export type Flag = FlagList["flags"][number];
export type FlagEnvironmentName = keyof Flag["environments"];
export type FlagSettings = Flag["environments"]["production"];
export type FlagEvaluation = Json<`${W}/flags/evaluate`, "post", 200>;
export type AuditList = Json<`${W}/audit-events`, "get", 200>;
export type AuditEvent = AuditList["events"][number];

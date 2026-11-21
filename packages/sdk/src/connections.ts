import { SecureCloudError, platformError } from "./errors.js";
import { Http, segment, type Body } from "./http.js";

export interface ProxyResponse<T = unknown> {
  status: number;
  ok: boolean;
  data: T;
  headers: Record<string, string>;
}

export interface CallOptions {
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean>;
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export class Connections {
  constructor(private readonly http: Http) {}

  async call<T = unknown>(
    connection: string,
    route: string,
    body?: unknown,
    options: CallOptions = {},
  ): Promise<ProxyResponse<T>> {
    const { method, path } = parseRoute(route);
    const headers: Record<string, string> = { ...options.headers };
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === "authorization") delete headers[name];
    }
    let payload: Body | undefined;
    if (body !== undefined && body !== null) {
      if (typeof body === "string" || body instanceof Uint8Array) {
        payload = typeof body === "string" ? body : new Uint8Array(body);
      } else {
        payload = JSON.stringify(body);
        headers["content-type"] ??= "application/json";
      }
    }
    const query = options.query
      ? `?${new URLSearchParams(
          Object.entries(options.query).map(([k, v]): [string, string] => [
            k,
            String(v),
          ]),
        ).toString()}`
      : "";
    const response = await this.http.send(
      `/v1/proxy/${segment(connection)}${path}${query}`,
      { method, headers, body: payload },
    );
    if (!response.ok) {
      const refused = await platformError(response);
      if (refused) throw refused;
    }
    const text = await response.text();
    let data: unknown = text;
    if ((response.headers.get("content-type") ?? "").includes("json")) {
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
    }
    return {
      status: response.status,
      ok: response.ok,
      data: data as T,
      headers: Object.fromEntries(response.headers),
    };
  }
}

export function parseRoute(route: string): { method: string; path: string } {
  const match = /^(?:([A-Za-z]+)\s+)?(\/\S*)$/.exec(route.trim());
  const method = (match?.[1] ?? "GET").toUpperCase();
  const path = match?.[2];
  if (
    !path ||
    !(METHODS as readonly string[]).includes(method) ||
    path.split(/[/?#]/).some((part) => part === "..") ||
    path.startsWith("//")
  ) {
    throw new SecureCloudError(
      0,
      "INVALID_ROUTE",
      `"${route}" isn't a route. Write a method and a path, like "POST /charges".`,
    );
  }
  return { method, path };
}

import { SecureCloudError, errorFrom } from "./errors.js";

export interface HttpOptions {
  url: string;
  apiKey: string;
  timeoutMs: number;
  fetch: typeof fetch;
}

export type Body = NonNullable<RequestInit["body"]>;

export interface SendOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: Body;
  stream?: boolean;
  withKey?: boolean;
  timeout?: boolean;
}

export class Http {
  constructor(private readonly options: HttpOptions) {}

  async send(path: string, init: SendOptions = {}): Promise<Response> {
    const headers: Record<string, string> = { ...init.headers };
    if (init.withKey !== false) {
      headers.authorization = `Bearer ${this.options.apiKey}`;
    }
    const request: RequestInit & { duplex?: "half" } = {
      method: init.method ?? "GET",
      headers,
      body: init.body,
      redirect: "manual",
    };
    if (init.stream) request.duplex = "half";
    if (init.timeout !== false) {
      request.signal = AbortSignal.timeout(this.options.timeoutMs);
    }
    try {
      return await this.options.fetch(`${this.options.url}${path}`, request);
    } catch (error) {
      const timedOut =
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError");
      throw new SecureCloudError(
        0,
        timedOut ? "TIMEOUT" : "UNREACHABLE",
        timedOut
          ? `secure-cloud didn't answer within ${this.options.timeoutMs / 1000} seconds.`
          : `Couldn't reach secure-cloud at ${this.options.url}. Check the URL and that the gateway is running.`,
      );
    }
  }

  async call(path: string, init?: SendOptions): Promise<Response> {
    const response = await this.send(path, init);
    if (!response.ok) throw await errorFrom(response);
    return response;
  }

  async json<T>(path: string, init?: SendOptions): Promise<T> {
    return (await (await this.call(path, init)).json()) as T;
  }

  static body(value: unknown): SendOptions {
    return {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    };
  }
}

export const segment = (value: string): string => encodeURIComponent(value);

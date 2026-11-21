import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  clearCsrfToken,
  NetworkError,
  onSessionEnded,
  request,
} from "@/lib/api/client";

type Call = { url: string; init: RequestInit };
let calls: Call[];
let answers: (() => Response)[];

const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const apiError = (
  status: number,
  code: string,
  message: string,
  requestId = "req-1234",
) =>
  json(
    status,
    { error: { code, message, requestId } },
    { "x-request-id": requestId },
  );

beforeEach(() => {
  clearCsrfToken();
  calls = [];
  answers = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit) => {
      calls.push({ url, init });
      const next = answers.shift();
      if (!next) throw new Error(`unexpected request to ${url}`);
      return Promise.resolve(next());
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("requests", () => {
  it("send cookies (credentials), never cache, and build the query string", async () => {
    answers.push(() => json(200, { ok: true }));

    await request("GET", "/dashboard/v1/workspaces/w/files", {
      query: { limit: 50, cursor: undefined },
    });

    expect(calls[0]?.url).toBe("/dashboard/v1/workspaces/w/files?limit=50");
    expect(calls[0]?.init).toMatchObject({
      credentials: "include",
      cache: "no-store",
    });
  });

  it("add the CSRF token to changes, fetching it once and keeping it in memory", async () => {
    answers.push(
      () => json(200, { csrfToken: "token-1" }),
      () => json(201, { name: "a" }),
      () => new Response(null, { status: 204 }),
    );

    await request("PUT", "/dashboard/v1/workspaces/w/secrets/a", {
      json: { value: "v" },
    });
    await request("DELETE", "/dashboard/v1/workspaces/w/secrets/a");

    expect(calls.map((c) => c.url)).toEqual([
      "/dashboard/v1/auth/csrf",
      "/dashboard/v1/workspaces/w/secrets/a",
      "/dashboard/v1/workspaces/w/secrets/a",
    ]);
    expect(calls[1]?.init.headers).toMatchObject({
      "x-csrf-token": "token-1",
      "content-type": "application/json",
    });
    expect(calls[2]?.init.headers).toMatchObject({ "x-csrf-token": "token-1" });
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it("don't send a CSRF token to sign-up or login", async () => {
    answers.push(() => json(200, { user: {}, workspaces: [] }));

    await request("POST", "/dashboard/v1/auth/login", {
      json: { email: "a@b.c", password: "x" },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.headers).not.toHaveProperty("x-csrf-token");
  });

  it("fetch a fresh CSRF token and retry once when the token is refused", async () => {
    answers.push(
      () => json(200, { csrfToken: "old" }),
      () =>
        apiError(
          403,
          "FORBIDDEN",
          "A valid CSRF token is required (X-CSRF-Token)",
        ),
      () => json(200, { csrfToken: "new" }),
      () => new Response(null, { status: 204 }),
    );

    await request("POST", "/dashboard/v1/auth/logout");

    expect(calls[3]?.init.headers).toMatchObject({ "x-csrf-token": "new" });
  });
});

describe("errors", () => {
  it("become ApiErrors with the gateway's code, message and request ID", async () => {
    answers.push(() =>
      apiError(
        409,
        "CONFLICT",
        "An account with this email already exists",
        "req-abc",
      ),
    );

    const error = await request("POST", "/dashboard/v1/auth/sign-up", {
      json: {},
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: "CONFLICT",
      message: "An account with this email already exists",
      requestId: "req-abc",
    });
  });

  it("keep the X-Request-Id header when the body isn't the error format", async () => {
    answers.push(
      () =>
        new Response("<html>bad gateway</html>", {
          status: 502,
          headers: { "x-request-id": "req-from-header" },
        }),
    );

    const error = (await request("GET", "/dashboard/v1/auth/me").catch(
      (e: unknown) => e,
    )) as ApiError;

    expect(error.code).toBe("UNKNOWN");
    expect(error.requestId).toBe("req-from-header");
    expect(error.message).toMatch(/HTTP 502/);
  });

  it("report a network failure clearly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );

    await expect(
      request("GET", "/dashboard/v1/auth/me"),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});

describe("the session ending", () => {
  it("tells listeners on a 401 from a signed-in route, but not from login", async () => {
    const ended = vi.fn();
    const stop = onSessionEnded(ended);
    answers.push(
      () => apiError(401, "UNAUTHORIZED", "Wrong email or password"),
      () => apiError(401, "UNAUTHORIZED", "Sign in first"),
    );

    await request("POST", "/dashboard/v1/auth/login", { json: {} }).catch(
      () => undefined,
    );
    expect(ended).not.toHaveBeenCalled();
    await request("GET", "/dashboard/v1/workspaces/w").catch(() => undefined);
    expect(ended).toHaveBeenCalledTimes(1);
    stop();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { charge } from "@/lib/payments";
import { listFiles, listSecrets, PlatformError } from "@/lib/platform/client";
import { describeError } from "@/lib/messages";

function reply(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const platformError = (code: string, requestId = "req-1") => ({
  error: { code, message: `${code} happened`, requestId },
});

beforeEach(() => {
  vi.stubEnv("PLATFORM_API_KEY", "sk_local_test");
  vi.stubEnv("PLATFORM_API_URL", "http://gateway:8080");
});

describe("platform client", () => {
  it("sends the API key from the server's environment", async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(reply(200, { files: [], nextCursor: null })),
    );
    vi.stubGlobal("fetch", fetch);
    await listFiles();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://gateway:8080/v1/storage/files?limit=100");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer sk_local_test",
    );
  });

  it("follows every page of files", async () => {
    const files = (id: string) => [
      { id, name: null, contentType: "text/plain", size: 1, createdAt: "t" },
    ];
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        reply(200, { files: files("a"), nextCursor: "c2" }),
      )
      .mockResolvedValueOnce(
        reply(200, { files: files("b"), nextCursor: null }),
      );
    vi.stubGlobal("fetch", fetch);
    expect((await listFiles()).map((f) => f.id)).toEqual(["a", "b"]);
    expect(String(fetch.mock.calls[1]?.[0])).toContain("cursor=c2");
  });

  it("turns the platform's error format into a PlatformError with its request ID", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(reply(503, platformError("SECRETS_SEALED")))),
    );
    const error = await listSecrets().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlatformError);
    expect(error).toMatchObject({
      status: 503,
      code: "SECRETS_SEALED",
      requestId: "req-1",
    });
    expect(describeError(error).title).toBe("Temporarily unavailable");
  });

  it("reports an unreachable platform, and a shop that isn't set up", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("fetch failed"))),
    );
    const error: unknown = await listFiles().catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "UNREACHABLE" });
    expect(describeError(error).title).toBe("Platform unreachable");
    vi.stubEnv("PLATFORM_API_KEY", "");
    await expect(listFiles()).rejects.toMatchObject({ code: "NOT_CONNECTED" });
  });
});

describe("payments through the connection", () => {
  it("a 201 from the provider is a charge", async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(reply(201, { id: "ch_1", status: "succeeded" })),
    );
    vi.stubGlobal("fetch", fetch);
    expect(await charge(1800, "1 x Field Notebook")).toEqual({
      ok: true,
      chargeId: "ch_1",
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://gateway:8080/v1/proxy/payments/charges");
    expect(JSON.parse(init.body as string)).toEqual({
      amount: 1800,
      currency: "sgd",
      description: "1 x Field Notebook",
    });
  });

  it("the provider's own errors are results, not platform errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(reply(402, { error: { type: "card_declined" } })),
      ),
    );
    expect(await charge(200_000, "x")).toEqual({
      ok: false,
      reason: "declined",
      status: 402,
    });
  });

  it("a refusal by the platform's payment policy is a PlatformError with its own message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(reply(403, platformError("PROXY_POLICY_DENIED"))),
      ),
    );
    const error = await charge(129_900, "x").catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 403, code: "PROXY_POLICY_DENIED" });
    expect(describeError(error)).toMatchObject({
      title: "Blocked by the payment policy",
      requestId: "req-1",
    });
  });

  it("the platform's own refusals (sealed) are PlatformErrors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(reply(503, platformError("SECRETS_SEALED")))),
    );
    await expect(charge(1800, "x")).rejects.toMatchObject({
      code: "SECRETS_SEALED",
    });
  });
});

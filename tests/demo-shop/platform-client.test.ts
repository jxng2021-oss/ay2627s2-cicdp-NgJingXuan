import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkoutResult, startCheckout } from "@/lib/payments";
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

const ORDER = "6f1c2a3b-0000-4000-8000-000000000001";
const SHOPPER = {
  id: "7a1c2a3b-0000-4000-8000-000000000002",
  email: "ada@example.com",
};
const order = (totalCents: number) => ({
  orderId: ORDER,
  slug: "field-notebook",
  name: "Field Notebook",
  quantity: 2,
  totalCents,
  shopper: SHOPPER,
});
const SESSION = "cs_test_a1B2c3D4e5F6g7H8";

describe("Stripe Checkout through the connection", () => {
  it("creates a Checkout Session with form data, the order as idempotency key, and returns Stripe's page", async () => {
    vi.stubEnv("SHOP_URL", "http://localhost:3100");
    const fetch = vi.fn(() =>
      Promise.resolve(
        reply(200, {
          id: SESSION,
          url: "https://checkout.stripe.com/c/pay/cs_test_x",
        }),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    expect(await startCheckout(order(3600))).toEqual({
      ok: true,
      url: "https://checkout.stripe.com/c/pay/cs_test_x",
      sessionId: SESSION,
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://gateway:8080/v1/proxy/stripe/checkout/sessions");
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(headers["idempotency-key"]).toBe(ORDER);
    expect(
      Object.fromEntries(new URLSearchParams(init.body as string)),
    ).toEqual({
      mode: "payment",
      "payment_method_types[0]": "card",
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "sgd",
      "line_items[0][price_data][unit_amount]": "3600",
      "line_items[0][price_data][product_data][name]": "2 x Field Notebook",
      success_url:
        "http://localhost:3100/orders/complete?session_id={CHECKOUT_SESSION_ID}",
      cancel_url:
        "http://localhost:3100/products/field-notebook?payment=cancelled",
      client_reference_id: ORDER,
      customer_email: "ada@example.com",
      "metadata[order_id]": ORDER,
      "metadata[shopper_id]": SHOPPER.id,
      "metadata[slug]": "field-notebook",
      "metadata[quantity]": "2",
      "payment_intent_data[metadata][order_id]": ORDER,
    });
  });

  it("refuses a payment page that isn't Stripe's, and reports Stripe's errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(reply(200, { url: "https://evil.example/pay" })),
      ),
    );
    expect(await startCheckout(order(3600))).toEqual({
      ok: false,
      status: 200,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(reply(400, { error: { type: "invalid" } }))),
    );
    expect(await startCheckout(order(3600))).toEqual({
      ok: false,
      status: 400,
    });
  });

  it("a paid session is read back from Stripe, never from the return link", async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(
        reply(200, {
          id: SESSION,
          payment_status: "paid",
          currency: "sgd",
          amount_total: 3600,
          payment_intent: "pi_123",
          metadata: {
            order_id: ORDER,
            shopper_id: SHOPPER.id,
            slug: "field-notebook",
            quantity: "2",
          },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    expect(await checkoutResult(SESSION)).toEqual({
      paid: true,
      session: {
        orderId: ORDER,
        shopperId: SHOPPER.id,
        slug: "field-notebook",
        quantity: 2,
        totalCents: 3600,
        paymentId: "pi_123",
      },
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      `http://gateway:8080/v1/proxy/stripe/checkout/sessions/${SESSION}`,
    );
    expect(init.method).toBe("GET");
  });

  it("an unpaid session isn't paid, and a made up session ID never reaches Stripe", async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(
        reply(200, { payment_status: "unpaid", currency: "sgd", metadata: {} }),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    expect(await checkoutResult(SESSION)).toEqual({
      paid: false,
      reason: "unpaid",
    });
    for (const bad of ["", "cs_test_x/../../charges", "pi_123", "cs_test_"]) {
      expect(await checkoutResult(bad)).toEqual({
        paid: false,
        reason: "unknown",
      });
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("a refusal by the platform's payment policy is a PlatformError with its own message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(reply(403, platformError("PROXY_POLICY_DENIED"))),
      ),
    );
    const error = await startCheckout(order(129_900)).catch((e: unknown) => e);
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
    await expect(startCheckout(order(1800))).rejects.toMatchObject({
      code: "SECRETS_SEALED",
    });
  });
});

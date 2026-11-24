import type { NextRequest } from "next/server";
import { applyPaymentEvent } from "@/lib/orders";
import { PlatformError, verifyWebhook } from "@/lib/platform/client";
import { shopDb } from "@/lib/shop-db";

const MAX_BODY = 64 * 1024;

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY) {
    return Response.json({ error: "too large" }, { status: 413 });
  }
  try {
    const event = await verifyWebhook(
      rawBody,
      request.headers.get("x-securecloud-signature"),
    );
    const outcome = await applyPaymentEvent(await shopDb(), event);
    return Response.json({ received: true, outcome });
  } catch (error) {
    if (error instanceof PlatformError && error.status === 401) {
      return Response.json({ error: "untrusted" }, { status: 401 });
    }
    console.error("webhook couldn't be handled", {
      reason: error instanceof Error ? error.name : "unknown",
    });
    return Response.json({ error: "try again" }, { status: 503 });
  }
}

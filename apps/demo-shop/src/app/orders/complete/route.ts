import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { markPaid } from "@/lib/orders";
import { checkoutResult } from "@/lib/payments";
import { shopDb } from "@/lib/shop-db";
import { currentShopper } from "@/lib/shoppers";

export async function GET(request: NextRequest) {
  const shopper = await currentShopper();
  if (!shopper) redirect("/account/sign-in?next=/account/orders");

  const sessionId = request.nextUrl.searchParams.get("session_id") ?? "";
  let outcome: string;
  try {
    const result = await checkoutResult(sessionId);
    if (!result.paid) {
      outcome = `/account/orders?payment=${result.reason}`;
    } else if (result.session.shopperId !== shopper.id) {
      outcome = "/account/orders?payment=unknown";
    } else {
      const order = await markPaid(await shopDb(), {
        orderId: result.session.orderId,
        shopperId: shopper.id,
        sessionId,
        paymentId: result.session.paymentId,
        totalCents: result.session.totalCents,
      });
      outcome = order
        ? `/orders/${order.id}`
        : "/account/orders?payment=unknown";
    }
  } catch {
    outcome = "/account/orders?payment=error";
  }
  redirect(outcome);
}

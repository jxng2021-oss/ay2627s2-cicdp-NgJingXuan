"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { findProduct, parseQuantity } from "@/lib/catalog";
import { describeError, type ErrorView } from "@/lib/messages";
import {
  attachCheckoutSession,
  createOrder,
  dropUnstartedOrder,
  type Db,
} from "@/lib/orders";
import { startCheckout } from "@/lib/payments";
import { shopDb } from "@/lib/shop-db";
import { currentShopper } from "@/lib/shoppers";

export interface CheckoutState {
  error?: ErrorView;
  signIn?: boolean;
}

export async function checkout(
  _previous: CheckoutState,
  form: FormData,
): Promise<CheckoutState> {
  const slug = form.get("slug");
  const product = typeof slug === "string" ? findProduct(slug) : undefined;
  const quantity = parseQuantity(form.get("quantity"));
  if (!product || !quantity) {
    return {
      error: {
        title: "Check the order",
        message: `Choose a product and a quantity from 1 to 5.`,
      },
    };
  }
  const shopper = await currentShopper();
  if (!shopper) {
    return {
      error: {
        title: "Sign in to buy",
        message:
          "Sign in or create an account first: your orders are kept with it.",
      },
      signIn: true,
    };
  }

  let url: string;
  let db: Db | undefined;
  let orderId: string | undefined;
  try {
    db = await shopDb();
    const order = await createOrder(db, {
      id: randomUUID(),
      shopper,
      slug: product.slug,
      productName: product.name,
      quantity,
      unitCents: product.priceCents,
    });
    orderId = order.id;
    const started = await startCheckout({
      orderId: order.id,
      slug: product.slug,
      name: product.name,
      quantity,
      totalCents: order.totalCents,
      shopper,
    });
    if (!started.ok) {
      await dropUnstartedOrder(db, order.id);
      return {
        error: {
          title: "Couldn't start the payment",
          message: `Stripe answered ${started.status}. Nothing was charged; retry later.`,
        },
      };
    }
    await attachCheckoutSession(db, order.id, started.sessionId);
    url = started.url;
  } catch (error) {
    if (db && orderId)
      await dropUnstartedOrder(db, orderId).catch(() => undefined);
    return { error: describeError(error) };
  }
  redirect(url);
}

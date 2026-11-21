"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { findProduct, parseQuantity } from "@/lib/catalog";
import { describeError, type ErrorView } from "@/lib/messages";
import { charge } from "@/lib/payments";
import { uploadFile } from "@/lib/platform/client";
import { receiptFileName, type Receipt } from "@/lib/receipts";
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
  const totalCents = product.priceCents * quantity;

  let fileId: string;
  try {
    const payment = await charge(totalCents, `${quantity} x ${product.name}`);
    if (!payment.ok) {
      return {
        error:
          payment.reason === "declined"
            ? {
                title: "Payment declined",
                message:
                  "The payment provider declined this order. Try a smaller order.",
              }
            : {
                title: "Payment failed",
                message: `The payment provider answered ${payment.status}. Nothing was charged; retry later.`,
              },
      };
    }

    const receipt: Receipt = {
      version: 1,
      orderId: randomUUID(),
      createdAt: new Date().toISOString(),
      items: [
        {
          slug: product.slug,
          name: product.name,
          quantity,
          unitCents: product.priceCents,
        },
      ],
      totalCents,
      currency: "sgd",
      chargeId: payment.chargeId,
      shopper,
    };
    const saved = await uploadFile(
      receiptFileName(receipt.orderId, shopper.id),
      "application/json",
      JSON.stringify(receipt),
    );
    fileId = saved.id;
  } catch (error) {
    return { error: describeError(error) };
  }
  redirect(`/orders/${fileId}`);
}

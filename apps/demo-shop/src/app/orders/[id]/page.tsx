import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ErrorBanner, formatDate, PageHeader, Status } from "@/components/ui";
import { formatPrice } from "@/lib/catalog";
import { describeError } from "@/lib/messages";
import {
  findShopperOrder,
  readOrders,
  STATUS_LABELS,
  type Order,
} from "@/lib/orders";
import { shopDb } from "@/lib/shop-db";
import { syncWebhookEvents } from "@/lib/webhook-sync";
import { currentShopper } from "@/lib/shoppers";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export default async function OrderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const shopper = await currentShopper();
  if (!shopper) redirect("/account/sign-in?next=/account/orders");

  let order: Order | undefined;
  try {
    order = await readOrders(
      await shopDb(),
      (db) => findShopperOrder(db, id, shopper.id),
      syncWebhookEvents,
    );
  } catch (error) {
    return <ErrorBanner error={describeError(error)} />;
  }
  if (!order) notFound();
  const paid = order.status === "paid" || order.status === "refunded";
  const refunded = order.refundedCents > 0;

  return (
    <div className="receipt">
      <PageHeader
        label={paid ? "Order Confirmed" : "Order"}
        title={paid ? "Thank you for your order" : "Payment not completed"}
        description={`Order ${order.id}, placed ${formatDate(order.createdAt)}.`}
      />
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Quantity</th>
              <th scope="col">Price</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td data-label="Item">{order.productName}</td>
              <td data-label="Quantity">{order.quantity}</td>
              <td data-label="Price">
                {formatPrice(order.unitCents * order.quantity)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        Total <span className="price">{formatPrice(order.totalCents)}</span>
      </p>
      <div className="stack-2">
        <p>
          <Status ok={order.status === "paid"}>
            {order.status === "paid"
              ? "Paid with Stripe"
              : STATUS_LABELS[order.status]}
          </Status>
        </p>
        {refunded && (
          <p>
            Refunded{" "}
            <span className="price">{formatPrice(order.refundedCents)}</span>
          </p>
        )}
        {order.stripePaymentId && (
          <p>
            Payment <code>{order.stripePaymentId}</code>
          </p>
        )}
        <p className="muted">
          Kept in the demo shop&apos;s own database. secure-cloud only passed
          the payment to Stripe, with the Stripe key the shop never sees.
        </p>
      </div>
      <p>
        <Link href="/">Continue Shopping</Link>
      </p>
    </div>
  );
}

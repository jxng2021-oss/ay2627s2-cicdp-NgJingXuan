import Link from "next/link";
import { redirect } from "next/navigation";
import { ErrorBanner, formatDate, PageHeader } from "@/components/ui";
import { formatPrice } from "@/lib/catalog";
import { describeError, paymentProblem } from "@/lib/messages";
import { listShopperOrders, readOrders, type Order } from "@/lib/orders";
import { shopDb } from "@/lib/shop-db";
import { syncWebhookEvents } from "@/lib/webhook-sync";
import { currentShopper } from "@/lib/shoppers";

export default async function MyOrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const problem = paymentProblem((await searchParams).payment);
  const shopper = await currentShopper();
  if (!shopper) redirect("/account/sign-in?next=/account/orders");

  let orders: Order[];
  try {
    orders = await readOrders(
      await shopDb(),
      (db) => listShopperOrders(db, shopper.id),
      syncWebhookEvents,
    );
  } catch (error) {
    return <ErrorBanner error={describeError(error)} />;
  }

  return (
    <>
      <PageHeader
        label="Your Account"
        title="My Orders"
        description={`Signed in as ${shopper.email}.`}
      />
      {problem && <ErrorBanner error={problem} />}
      {orders.length === 0 ? (
        <p className="muted">
          No orders yet. <Link href="/">Browse the products</Link>.
        </p>
      ) : (
        <ul className="order-list" aria-label="Your orders">
          {orders.map((order) => (
            <li key={order.id}>
              <Link href={`/orders/${order.id}`}>
                {order.quantity} x {order.productName},{" "}
                {formatPrice(order.totalCents)}, placed{" "}
                {formatDate(order.createdAt)}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

import { ErrorBanner, formatDate, PageHeader, Status } from "@/components/ui";
import { formatPrice } from "@/lib/catalog";
import { describeError } from "@/lib/messages";
import {
  listOrders,
  readOrders,
  STATUS_LABELS,
  type Order,
} from "@/lib/orders";
import { shopDb } from "@/lib/shop-db";
import { syncWebhookEvents } from "@/lib/webhook-sync";

export default async function AdminOrdersPage() {
  let orders: Order[] = [];
  let problem: ReturnType<typeof describeError> | null = null;
  try {
    orders = await readOrders(await shopDb(), listOrders, syncWebhookEvents);
  } catch (error) {
    problem = describeError(error);
  }

  return (
    <>
      <PageHeader
        label="Admin"
        title="Orders"
        description="Every order, from the demo shop's own database. Pending orders are customers who went to Stripe and haven't paid."
      />
      {problem && <ErrorBanner error={problem} />}
      {!problem && orders.length === 0 ? (
        <div className="card">
          <p className="muted">No orders yet. Buy a product to make one.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table" aria-label="Orders">
            <thead>
              <tr>
                <th scope="col">Placed</th>
                <th scope="col">Customer</th>
                <th scope="col">Item</th>
                <th scope="col">Total</th>
                <th scope="col">Status</th>
                <th scope="col">Stripe Payment</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.id}>
                  <td data-label="Placed">{formatDate(order.createdAt)}</td>
                  <td data-label="Customer">{order.shopperEmail}</td>
                  <td data-label="Item">
                    {order.quantity} x {order.productName}
                  </td>
                  <td data-label="Total">{formatPrice(order.totalCents)}</td>
                  <td data-label="Status">
                    <Status ok={order.status === "paid"}>
                      {STATUS_LABELS[order.status]}
                    </Status>
                  </td>
                  <td data-label="Stripe Payment">
                    {order.stripePaymentId ? (
                      <code>{order.stripePaymentId}</code>
                    ) : (
                      "–"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

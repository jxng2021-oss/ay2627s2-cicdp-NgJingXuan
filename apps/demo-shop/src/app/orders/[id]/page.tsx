import Link from "next/link";
import { notFound } from "next/navigation";
import { ErrorBanner, formatDate, PageHeader, Status } from "@/components/ui";
import { formatPrice } from "@/lib/catalog";
import { describeError } from "@/lib/messages";
import { fileBody, fileMetadata, PlatformError } from "@/lib/platform/client";
import {
  isReceiptFile,
  MAX_RECEIPT_BYTES,
  parseReceipt,
  type Receipt,
} from "@/lib/receipts";
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

  let receipt: Receipt | null;
  try {
    const file = await fileMetadata(id);
    if (!isReceiptFile(file.name) || file.size > MAX_RECEIPT_BYTES) notFound();
    receipt = parseReceipt(await new Response(await fileBody(id)).text());
    if (!receipt) notFound();
    if (receipt.shopper) {
      const shopper = await currentShopper();
      if (shopper?.id !== receipt.shopper.id) notFound();
    }
  } catch (error) {
    if (error instanceof PlatformError && error.status === 404) notFound();
    if (!(error instanceof PlatformError)) throw error;
    return <ErrorBanner error={describeError(error)} />;
  }

  return (
    <div className="receipt">
      <PageHeader
        label="Order Confirmed"
        title="Thank you for your order"
        description={`Order ${receipt.orderId}, placed ${formatDate(receipt.createdAt)}.`}
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
            {receipt.items.map((item) => (
              <tr key={item.slug}>
                <td data-label="Item">{item.name}</td>
                <td data-label="Quantity">{item.quantity}</td>
                <td data-label="Price">
                  {formatPrice(item.unitCents * item.quantity)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        Total <span className="price">{formatPrice(receipt.totalCents)}</span>
      </p>
      <div className="stack-2">
        <p>
          Payment <code>{receipt.chargeId}</code>
        </p>
        <p>
          <Status ok>Stored encrypted on secure-cloud</Status>
        </p>
        <p className="muted">
          File <code>{id}</code>. The platform encrypts and authenticates it, so
          it can&apos;t be changed without being detected.
        </p>
      </div>
      <p>
        <Link href="/">Continue Shopping</Link>
      </p>
    </div>
  );
}

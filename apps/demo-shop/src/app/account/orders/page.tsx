import Link from "next/link";
import { redirect } from "next/navigation";
import { ErrorBanner, formatDate, PageHeader } from "@/components/ui";
import { describeError } from "@/lib/messages";
import { listFiles, type FileInfo } from "@/lib/platform/client";
import { shopperReceiptPrefix } from "@/lib/receipts";
import { currentShopper } from "@/lib/shoppers";

export default async function MyOrdersPage() {
  const shopper = await currentShopper();
  if (!shopper) redirect("/account/sign-in?next=/account/orders");

  let receipts: FileInfo[];
  try {
    const prefix = shopperReceiptPrefix(shopper.id);
    receipts = (await listFiles()).filter((file) =>
      file.name?.startsWith(prefix),
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
      {receipts.length === 0 ? (
        <p className="muted">
          No orders yet. <Link href="/">Browse the products</Link>.
        </p>
      ) : (
        <ul className="order-list" aria-label="Your orders">
          {receipts.map((file) => (
            <li key={file.id}>
              <Link href={`/orders/${file.id}`}>
                Order placed {formatDate(file.createdAt)}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

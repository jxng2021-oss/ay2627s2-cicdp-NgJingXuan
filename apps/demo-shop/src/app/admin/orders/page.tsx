import Link from "next/link";
import { ErrorBanner, formatDate, PageHeader } from "@/components/ui";
import { describeError } from "@/lib/messages";
import { listFiles, type FileInfo } from "@/lib/platform/client";
import { isReceiptFile } from "@/lib/receipts";

export default async function AdminOrdersPage() {
  let receipts: FileInfo[] = [];
  let problem: ReturnType<typeof describeError> | null = null;
  try {
    receipts = (await listFiles())
      .filter((file) => isReceiptFile(file.name))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch (error) {
    problem = describeError(error);
  }

  return (
    <>
      <PageHeader
        label="Admin"
        title="Orders"
        description="Receipts, stored as encrypted files on secure-cloud."
      />
      {problem && <ErrorBanner error={problem} />}
      {!problem && receipts.length === 0 ? (
        <div className="card">
          <p className="muted">No orders yet. Buy a product to make one.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Placed</th>
                <th scope="col">Receipt File</th>
                <th scope="col">
                  <span className="sr-only">Open</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {receipts.map((file) => (
                <tr key={file.id}>
                  <td data-label="Placed">{formatDate(file.createdAt)}</td>
                  <td data-label="Receipt File">
                    <code>{file.name}</code>
                  </td>
                  <td className="actions">
                    <Link href={`/orders/${file.id}`}>View Receipt</Link>
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

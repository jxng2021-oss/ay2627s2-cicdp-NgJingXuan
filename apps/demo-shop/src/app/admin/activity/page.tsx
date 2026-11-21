import Link from "next/link";
import { ErrorBanner, formatDate, PageHeader } from "@/components/ui";
import { describeError } from "@/lib/messages";
import { auditEvents, type AuditPage } from "@/lib/platform/client";

const ACTIONS = [
  "proxy_connection.used",
  "proxy_connection.denied",
  "secret.read",
  "file.uploaded",
  "file.downloaded",
  "file.deleted",
] as const;

export default async function AdminActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; cursor?: string }>;
}) {
  const query = await searchParams;
  const action = ACTIONS.find((a) => a === query.action);
  const cursor =
    typeof query.cursor === "string" &&
    /^[A-Za-z0-9_-]{1,200}$/.test(query.cursor)
      ? query.cursor
      : undefined;

  let page: AuditPage | undefined;
  let problem: ReturnType<typeof describeError> | null = null;
  try {
    page = await auditEvents({ action, cursor });
  } catch (error) {
    problem = describeError(error);
  }

  return (
    <>
      <PageHeader
        label="Admin"
        title="Activity"
        description="What the shop did on secure-cloud, from the platform's tamper-evident audit log."
      />
      <form className="row" method="get">
        <label htmlFor="action" className="sr-only">
          Action
        </label>
        <select
          id="action"
          name="action"
          className="select"
          defaultValue={action ?? ""}
        >
          <option value="">All actions</option>
          {ACTIONS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <button type="submit" className="button" data-variant="secondary">
          Apply Filter
        </button>
      </form>
      {problem && <ErrorBanner error={problem} />}
      {page && page.events.length === 0 && (
        <div className="card">
          <p className="muted">No events yet. Buy a product to make some.</p>
        </div>
      )}
      {page && page.events.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Action</th>
                <th scope="col">Resource</th>
                <th scope="col">Outcome</th>
                <th scope="col">Request ID</th>
              </tr>
            </thead>
            <tbody>
              {page.events.map((event) => (
                <tr key={event.id}>
                  <td data-label="Time">{formatDate(event.occurredAt)}</td>
                  <td data-label="Action">
                    <code>{event.action}</code>
                  </td>
                  <td data-label="Resource">
                    <span>
                      {event.resourceType} <code>{event.resourceId ?? ""}</code>
                    </span>
                  </td>
                  <td data-label="Outcome">{event.outcome}</td>
                  <td data-label="Request ID">
                    <code>{event.requestId ?? ""}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {page?.nextCursor && (
        <p>
          <Link
            href={`/admin/activity?${new URLSearchParams({
              ...(action ? { action } : {}),
              cursor: page.nextCursor,
            })}`}
          >
            Older Events
          </Link>
        </p>
      )}
    </>
  );
}

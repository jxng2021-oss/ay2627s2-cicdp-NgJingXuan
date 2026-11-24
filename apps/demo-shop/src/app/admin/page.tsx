import { ErrorBanner, PageHeader, Status } from "@/components/ui";
import { describeError } from "@/lib/messages";
import { STRIPE_CONNECTION } from "@/lib/payments";
import {
  isConnected,
  listConnections,
  listSecrets,
  storageUsage,
  type Connection,
  type SecretSummary,
  type Usage,
} from "@/lib/platform/client";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default async function AdminPage() {
  let usage: Usage | undefined;
  let secrets: SecretSummary[] = [];
  let connections: Connection[] = [];
  let problem: ReturnType<typeof describeError> | null = null;
  try {
    [usage, secrets, connections] = await Promise.all([
      storageUsage(),
      listSecrets(),
      listConnections(),
    ]);
  } catch (error) {
    problem = describeError(error);
  }
  const payments = connections.find((c) => c.name === STRIPE_CONNECTION);
  const paymentKey = secrets.find((s) => s.name === payments?.secretName);

  return (
    <>
      <PageHeader
        label="Admin"
        title="Platform"
        description="What this shop uses on secure-cloud, through its API key."
      />
      {problem && <ErrorBanner error={problem} />}
      <div className="stats">
        <section className="card stack-2" aria-label="API key">
          <p className="sec-label">API Key</p>
          <Status ok={isConnected() && !problem}>
            {!isConnected()
              ? "Not set up"
              : problem
                ? "Not working"
                : "Connected"}
          </Status>
          <p className="muted">Kept on the shop&apos;s server only.</p>
        </section>
        <section className="card stack-2" aria-label="Encrypted storage">
          <p className="sec-label">Encrypted Storage</p>
          <p className="stat-value">
            {usage ? formatBytes(usage.usedBytes) : "–"}
          </p>
          <p className="muted">
            {usage
              ? `of ${formatBytes(usage.limitBytes)}: product photos`
              : "Unknown"}
          </p>
        </section>
        <section className="card stack-2" aria-label="Payment key">
          <p className="sec-label">Payment Key</p>
          <Status ok={paymentKey !== undefined}>
            {paymentKey ? `Secret v${paymentKey.latestVersion}` : "Missing"}
          </Status>
          <p className="muted">
            Your Stripe test key, write-only: the shop can never read it. The
            platform adds it to each payment.
          </p>
        </section>
        <section className="card stack-2" aria-label="Stripe connection">
          <p className="sec-label">Stripe Connection</p>
          <Status ok={payments !== undefined}>
            {payments ? "Ready" : "Missing"}
          </Status>
          <p className="muted">
            {payments ? (
              <>
                <code>{payments.baseUrl}</code> with secret{" "}
                <code>{payments.secretName}</code>
              </>
            ) : (
              "Run pnpm demo:setup with STRIPE_SECRET_KEY set."
            )}
          </p>
        </section>
      </div>
    </>
  );
}

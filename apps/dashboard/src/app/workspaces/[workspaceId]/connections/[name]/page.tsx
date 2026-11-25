"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import {
  describePolicy,
  formToPolicy,
  PolicyFields,
  policyToForm,
  type PolicyForm,
} from "@/components/policy";
import {
  Banner,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  FormError,
  InfoTip,
  Loading,
  PageHeader,
  formatDate,
} from "@/components/ui";
import type { Connection } from "@/lib/api/client";
import { workspace as api } from "@/lib/api/endpoints";
import { useToast } from "@/lib/toast";
import { useLoad } from "@/lib/use-load";
import { useWorkspace } from "@/lib/workspace";

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export default function ConnectionPage() {
  const params = useParams<{ name: string }>();
  const name = decoded(params.name);
  const { id, isOwner } = useWorkspace();
  const toast = useToast();
  const router = useRouter();
  const list = useLoad(() => api.connections(id), [id]);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const back = `/workspaces/${id}/connections`;

  if (list.status === "loading") return <Loading />;
  if (list.status === "error") {
    return <ErrorState error={list.error} onRetry={list.reload} />;
  }
  const connection = list.data.connections.find((c) => c.name === name);
  if (!connection) {
    return (
      <EmptyState>
        This connection doesn&apos;t exist.{" "}
        <Link href={back}>Back to connections</Link>
      </EmptyState>
    );
  }

  async function remove() {
    setBusy(true);
    setFailure(undefined);
    try {
      await api.deleteConnection(id, name);
      toast(`Connection ${name} removed`);
      router.replace(back);
    } catch (error) {
      setFailure(error);
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        label="Connection"
        title={connection.name}
        description="Apps call it with their API key; the platform adds the secret and forwards the request."
        actions={
          <Link className="button" data-variant="ghost" href={back}>
            All connections
          </Link>
        }
      />

      <Card title="Details">
        <div className="section">
          <h2>Details</h2>
          <dl className="details-grid">
            <dt>Proxy URL</dt>
            <dd className="mono">/v1/proxy/{connection.name}/...</dd>
            <dt>Forwards to</dt>
            <dd className="mono">{connection.baseUrl}</dd>
            <dt>Secret</dt>
            <dd>
              <code>{connection.secretName}</code>, in the{" "}
              <span className="mono">{connection.headerName}</span> header
              {connection.headerPrefix && (
                <>
                  {" "}
                  after{" "}
                  <span className="mono">
                    &quot;{connection.headerPrefix}&quot;
                  </span>
                </>
              )}
            </dd>
            {!isOwner && (
              <>
                <dt>Policy</dt>
                <dd>
                  <span className="policy-summary">
                    {describePolicy(connection.policy).map((line) => (
                      <span key={line}>{line}</span>
                    ))}
                  </span>
                </dd>
              </>
            )}
            <dt>Updated</dt>
            <dd>{formatDate(connection.updatedAt)}</dd>
          </dl>
        </div>
      </Card>

      {connection.policy && <Usage connection={connection} />}

      {isOwner ? (
        <PolicyEditor
          key={connection.updatedAt}
          connection={connection}
          onSaved={() => {
            toast(`Policy of ${connection.name} saved`);
            list.reload();
          }}
        />
      ) : (
        <Banner title="Viewing as a member">
          Only workspace owners can change or remove connections.
        </Banner>
      )}

      {isOwner && (
        <Card title="Remove connection">
          <div className="section">
            <h2>Remove connection</h2>
            <p className="muted">
              Calls to <code>/v1/proxy/{connection.name}/...</code> fail from
              then on. Its secret is kept.
            </p>
            <div>
              <Button variant="danger" onClick={() => setRemoving(true)}>
                Remove connection
              </Button>
            </div>
          </div>
        </Card>
      )}

      <ConfirmDialog
        open={removing}
        title="Remove connection"
        confirmLabel="Remove connection"
        busyLabel="Removing..."
        busy={busy}
        error={failure}
        onConfirm={() => void remove()}
        onCancel={() => {
          setRemoving(false);
          setFailure(undefined);
        }}
      >
        <p>
          Requests to <code>/v1/proxy/{connection.name}/...</code> will fail
          from now on. Its secret is kept.
        </p>
      </ConfirmDialog>
    </>
  );
}

function Usage({ connection }: { connection: Connection }) {
  const { id } = useWorkspace();
  const usage = useLoad(
    () => api.connectionUsage(id, connection.name),
    [id, connection.name, connection.updatedAt],
  );
  const n = (value: number) => value.toLocaleString("en");
  const percent = (used: number, limit: number) =>
    Math.min(100, (used / Math.max(1, limit)) * 100);
  const level = (used: number, limit: number) => {
    const share = used / Math.max(1, limit);
    return share >= 0.95 ? "full" : share >= 0.8 ? "high" : "ok";
  };

  return (
    <Card title="Usage">
      <div className="section">
        <div className="row row-between">
          <h2>Usage</h2>
          <Button variant="ghost" onClick={usage.reload}>
            Refresh usage
          </Button>
        </div>
        {usage.status === "loading" && <Loading />}
        {usage.status === "error" && (
          <ErrorState error={usage.error} onRetry={usage.reload} />
        )}
        {usage.status === "ready" && (
          <div className="stack-4">
            {usage.data.calls && (
              <div className="stack-2">
                <p className="sec-label">Calls this window</p>
                <p className="mono">
                  {n(usage.data.calls.used)} of {n(usage.data.calls.limit)} (per{" "}
                  {usage.data.calls.windowSeconds}s
                  {usage.data.calls.used > 0 &&
                    usage.data.calls.resetSeconds > 0 &&
                    `, resets in ${usage.data.calls.resetSeconds}s`}
                  )
                </p>
                <div
                  className="progress"
                  role="meter"
                  aria-label="Calls this window"
                  aria-valuemin={0}
                  aria-valuemax={usage.data.calls.limit}
                  aria-valuenow={usage.data.calls.used}
                  data-level={level(
                    usage.data.calls.used,
                    usage.data.calls.limit,
                  )}
                >
                  <span
                    style={{
                      width: `${percent(usage.data.calls.used, usage.data.calls.limit)}%`,
                    }}
                  />
                </div>
              </div>
            )}
            {usage.data.amount && (
              <div className="stack-2">
                <span className="field-label">
                  <span className="sec-label">
                    Amount requested today ({usage.data.day} UTC)
                  </span>
                  <InfoTip label="What counts towards the amount today">
                    Every call the outside API accepted counts, whether or not
                    it was paid in the end. An abandoned checkout still counts.
                  </InfoTip>
                </span>
                <p className="mono">
                  {n(usage.data.amount.usedToday)} of{" "}
                  {n(usage.data.amount.maxPerDay)}
                </p>
                <p className="hint">
                  Counted from <code>{usage.data.amount.field}</code>.
                </p>
                <div
                  className="progress"
                  role="meter"
                  aria-label="Amount requested today"
                  aria-valuemin={0}
                  aria-valuemax={usage.data.amount.maxPerDay}
                  aria-valuenow={usage.data.amount.usedToday}
                  data-level={level(
                    usage.data.amount.usedToday,
                    usage.data.amount.maxPerDay,
                  )}
                >
                  <span
                    style={{
                      width: `${percent(usage.data.amount.usedToday, usage.data.amount.maxPerDay)}%`,
                    }}
                  />
                </div>
              </div>
            )}
            {!usage.data.calls && !usage.data.amount && (
              <p className="muted">
                This policy only limits routes: there is nothing to count.
              </p>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

function PolicyEditor({
  connection,
  onSaved,
}: {
  connection: Connection;
  onSaved: () => void;
}) {
  const { id } = useWorkspace();
  const [policy, setPolicy] = useState<PolicyForm>(
    policyToForm(connection.policy),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>();

  async function save(event: FormEvent) {
    event.preventDefault();
    const checked = formToPolicy(policy);
    if ("errors" in checked) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    setBusy(true);
    setFailure(undefined);
    try {
      await api.saveConnection(id, connection.name, {
        baseUrl: connection.baseUrl,
        secretName: connection.secretName,
        headerName: connection.headerName,
        headerPrefix: connection.headerPrefix,
        ...(checked.policy ? { policy: checked.policy } : {}),
      });
      onSaved();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Edit policy">
      <form className="form" onSubmit={(event) => void save(event)} noValidate>
        <h2>Edit policy</h2>
        <PolicyFields form={policy} errors={errors} onChange={setPolicy} />
        <FormError error={failure} />
        <div className="form-actions">
          <Button variant="primary" type="submit" disabled={busy}>
            {busy ? "Saving..." : "Save policy"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

"use client";

import { useId, useState, type FormEvent } from "react";
import {
  Button,
  Card,
  ConfirmDialog,
  CopyButton,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  Loading,
  PageHeader,
  Status,
  formatDate,
  type StatusTone,
} from "@/components/ui";
import type { WebhookEndpoint } from "@/lib/api/client";
import { workspace as api } from "@/lib/api/endpoints";
import { useToast } from "@/lib/toast";
import { useLoad } from "@/lib/use-load";
import { useWorkspace } from "@/lib/workspace";

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

const DELIVERY: Record<string, { tone: StatusTone; label: string }> = {
  delivered: { tone: "success", label: "Delivered" },
  pending: { tone: "warning", label: "Retrying" },
  failed: { tone: "danger", label: "Gave up" },
  pull: { tone: "info", label: "Waiting for pull" },
};

const EVENT_LABELS: Record<string, string> = {
  "payment.succeeded": "Payment succeeded",
  "payment.failed": "Payment failed",
  "refund.succeeded": "Refund succeeded",
};

const money = (amount: number | null, currency: string | null) =>
  amount === null
    ? "–"
    : `${(amount / 100).toFixed(2)} ${(currency ?? "").toUpperCase()}`;

export default function WebhooksPage() {
  const { id, isOwner } = useWorkspace();
  const list = useLoad(() => api.webhooks(id), [id]);
  const [creating, setCreating] = useState(false);

  return (
    <>
      <PageHeader
        label="Workspace"
        title="Webhooks"
        description="Stripe tells secure-cloud when a payment succeeds, fails or is refunded. secure-cloud checks Stripe's signature, turns it into a short event and sends it to your dev app signed with secure-cloud's own key."
        actions={
          isOwner && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              Create endpoint
            </Button>
          )
        }
      />
      <HowItWorks />
      {list.status === "loading" && <Loading />}
      {list.status === "error" && (
        <ErrorState error={list.error} onRetry={list.reload} />
      )}
      {list.status === "ready" &&
        (list.data.endpoints.length === 0 ? (
          <EmptyState>
            No webhook endpoints yet.{" "}
            {isOwner
              ? "Create one, then paste its address into Stripe."
              : "An owner can create one."}
          </EmptyState>
        ) : (
          <div className="stack-6">
            {list.data.endpoints.map((endpoint) => (
              <EndpointCard
                key={endpoint.id}
                endpoint={endpoint}
                onDeleted={list.reload}
              />
            ))}
          </div>
        ))}
      {isOwner && (
        <CreateDialog
          open={creating}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            list.reload();
          }}
        />
      )}
    </>
  );
}

function HowItWorks() {
  return (
    <Card title="How it works">
      <ol className="stack-2 webhook-steps">
        <li>
          Save Stripe&apos;s webhook signing secret (it starts with whsec_) in
          Secrets.
        </li>
        <li>
          Create an endpoint here and paste its Stripe address into Stripe
          (Developers, Webhooks), choosing the checkout.session and
          charge.refunded events.
        </li>
        <li>
          Your dev app checks each event with{" "}
          <code>cloud.webhooks.verify(rawBody, signature)</code> from the SDK,
          or pulls them with <code>cloud.webhooks.events()</code> when
          secure-cloud can&apos;t reach it (for example on localhost).
        </li>
      </ol>
    </Card>
  );
}

function EndpointCard({
  endpoint,
  onDeleted,
}: {
  endpoint: WebhookEndpoint;
  onDeleted: () => void;
}) {
  const { id, isOwner } = useWorkspace();
  const toast = useToast();
  const events = useLoad(
    () => api.webhookEvents(id, endpoint.id),
    [id, endpoint.id],
  );
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function remove() {
    setBusy(true);
    setError(undefined);
    try {
      await api.deleteWebhook(id, endpoint.id);
      setConfirming(false);
      toast(`Deleted the ${endpoint.name} endpoint.`);
      onDeleted();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  async function redeliver(eventId: string) {
    try {
      await api.redeliverWebhookEvent(id, endpoint.id, eventId);
      toast("Sending the event again.");
      setTimeout(events.reload, 1500);
    } catch {
      toast("Couldn't send the event again. Try once more.");
    }
  }

  return (
    <section className="card stack-4" aria-labelledby={`${endpoint.id}-name`}>
      <div className="webhook-head">
        <h2 id={`${endpoint.id}-name`} className="heading-5">
          {endpoint.name}
        </h2>
        <Status tone={endpoint.forwardUrl ? "success" : "info"}>
          {endpoint.forwardUrl
            ? "Pushes to your dev app"
            : "Your dev app pulls"}
        </Status>
      </div>
      <dl className="webhook-facts">
        <dt>Stripe address</dt>
        <dd>
          <code className="mono">{endpoint.stripeUrl}</code>{" "}
          <CopyButton value={endpoint.stripeUrl} label="Copy Stripe address" />
        </dd>
        <dt>Endpoint ID</dt>
        <dd>
          <code>{endpoint.id}</code>{" "}
          <CopyButton value={endpoint.id} label="Copy endpoint ID" />
        </dd>
        <dt>Stripe signing secret</dt>
        <dd>
          <code>{endpoint.signingSecretName}</code>
        </dd>
        <dt>Delivery address</dt>
        <dd>
          {endpoint.forwardUrl ? (
            <code className="mono">{endpoint.forwardUrl}</code>
          ) : (
            "None: events wait until your dev app pulls them"
          )}
        </dd>
      </dl>

      <h3 className="heading-6">Latest events</h3>
      {events.status === "loading" && <Loading />}
      {events.status === "error" && (
        <ErrorState error={events.error} onRetry={events.reload} />
      )}
      {events.status === "ready" &&
        (events.data.events.length === 0 ? (
          <p className="muted">
            No events yet. They appear here once Stripe sends one.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Event</th>
                  <th scope="col">Order</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Received</th>
                  <th scope="col">Delivery</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {events.data.events.map((event) => {
                  const delivery = DELIVERY[event.deliveryStatus]!;
                  return (
                    <tr key={event.id}>
                      <td data-label="Event">
                        {EVENT_LABELS[event.event] ?? event.event}
                        {event.reason && (
                          <span className="muted"> ({event.reason})</span>
                        )}
                      </td>
                      <td data-label="Order">
                        {event.orderId ? <code>{event.orderId}</code> : "–"}
                      </td>
                      <td data-label="Amount">
                        {money(event.amount, event.currency)}
                      </td>
                      <td data-label="Received">
                        {formatDate(event.receivedAt)}
                      </td>
                      <td data-label="Delivery">
                        <Status tone={delivery.tone}>{delivery.label}</Status>
                        {event.lastError &&
                          event.deliveryStatus !== "delivered" && (
                            <span className="muted"> {event.lastError}</span>
                          )}
                      </td>
                      <td className="actions">
                        {isOwner &&
                          endpoint.forwardUrl &&
                          event.deliveryStatus !== "pull" && (
                            <Button
                              variant="ghost"
                              onClick={() => void redeliver(event.id)}
                            >
                              Send again
                            </Button>
                          )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}

      {isOwner && (
        <div>
          <Button variant="danger" onClick={() => setConfirming(true)}>
            Delete endpoint
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        title={`Delete the ${endpoint.name} endpoint?`}
        confirmLabel="Delete endpoint"
        busyLabel="Deleting..."
        busy={busy}
        error={error}
        onConfirm={() => void remove()}
        onCancel={() => setConfirming(false)}
      >
        Stripe&apos;s events to this address will be refused, and its event
        history is deleted. Remove the address in Stripe too.
      </ConfirmDialog>
    </section>
  );
}

function CreateDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { id } = useWorkspace();
  const toast = useToast();
  const secrets = useLoad(() => api.secrets(id), [id]);
  const secretSelectId = useId();
  const [name, setName] = useState("stripe");
  const [secretName, setSecretName] = useState("");
  const [forwardUrl, setForwardUrl] = useState("");
  const [nameError, setNameError] = useState<string>();
  const [secretError, setSecretError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  const secretNames =
    secrets.status === "ready" ? secrets.data.secrets.map((s) => s.name) : [];

  async function submit(event: FormEvent) {
    event.preventDefault();
    const badName = NAME_PATTERN.test(name)
      ? undefined
      : "Use lowercase letters, numbers and dashes.";
    const badSecret = secretName ? undefined : "Choose one of your secrets.";
    setNameError(badName);
    setSecretError(badSecret);
    if (badName || badSecret) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.createWebhook(id, {
        name,
        signingSecretName: secretName,
        forwardUrl: forwardUrl.trim() || null,
      });
      toast(`Created the ${name} endpoint. Paste its address into Stripe.`);
      onCreated();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} title="Create a webhook endpoint" onClose={onClose}>
      <form className="stack-4" onSubmit={(e) => void submit(e)} noValidate>
        <Field
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={nameError}
          hint="For you to recognise it, for example stripe."
          required
        />
        <div className="field">
          <label htmlFor={secretSelectId}>Stripe signing secret</label>
          {secretNames.length > 0 ? (
            <select
              id={secretSelectId}
              className="select"
              value={secretName}
              onChange={(e) => setSecretName(e.target.value)}
              aria-invalid={secretError ? true : undefined}
              aria-describedby={`${secretSelectId}-hint${secretError ? ` ${secretSelectId}-error` : ""}`}
            >
              <option value="">Choose a secret</option>
              {secretNames.map((secret) => (
                <option key={secret} value={secret}>
                  {secret}
                </option>
              ))}
            </select>
          ) : (
            <p className="muted" id={`${secretSelectId}-hint`}>
              Save Stripe&apos;s whsec_ value in Secrets first.
            </p>
          )}
          {secretNames.length > 0 && (
            <p className="hint" id={`${secretSelectId}-hint`}>
              The secret holding Stripe&apos;s whsec_ value. secure-cloud uses
              it to check that events really come from Stripe.
            </p>
          )}
          {secretError && (
            <p className="field-error" id={`${secretSelectId}-error`}>
              {secretError}
            </p>
          )}
        </div>
        <Field
          label="Delivery address (optional)"
          value={forwardUrl}
          onChange={(e) => setForwardUrl(e.target.value)}
          placeholder="https://shop.example.com/webhooks/secure-cloud"
          hint="Where secure-cloud sends events. Leave it empty if your dev app pulls them instead."
          inputMode="url"
        />
        <FormError error={error} />
        <div className="form-actions">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={busy}>
            {busy ? "Creating..." : "Create endpoint"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

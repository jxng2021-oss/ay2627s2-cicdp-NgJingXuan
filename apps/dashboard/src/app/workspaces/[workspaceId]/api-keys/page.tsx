"use client";

import { useState, type FormEvent } from "react";
import {
  Banner,
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  Loading,
  PageHeader,
  Status,
  formatDate,
} from "@/components/ui";
import type { ApiKeyList } from "@/lib/api/client";
import { workspace as api } from "@/lib/api/endpoints";
import { useToast } from "@/lib/toast";
import { useLoad } from "@/lib/use-load";
import { useWorkspace } from "@/lib/workspace";

type Key = ApiKeyList["apiKeys"][number];

export default function ApiKeysPage() {
  const { id, isOwner } = useWorkspace();
  const toast = useToast();
  const keys = useLoad(() => api.apiKeys(id), [id]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const [newKey, setNewKey] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<Key>();

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setNameError("Name the key, like ci-deploy.");
      return;
    }
    setNameError(undefined);
    setBusy(true);
    setFailure(undefined);
    try {
      const created = await api.createApiKey(id, name.trim());
      setCreating(false);
      setName("");
      setNewKey(created.key);
      setCopied(false);
      keys.reload();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!revoking) return;
    setBusy(true);
    setFailure(undefined);
    try {
      await api.revokeApiKey(id, revoking.id);
      toast(`API key ${revoking.name} revoked`);
      setRevoking(undefined);
      keys.reload();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!newKey) return;
    await navigator.clipboard.writeText(newKey);
    setCopied(true);
  }

  return (
    <>
      <PageHeader
        label="Workspace"
        title="API keys"
        description="Apps use API keys to call the public API. A key is only shown once, when it's created."
        actions={
          isOwner && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              Create API key
            </Button>
          )
        }
      />

      {newKey && (
        <section className="banner" aria-labelledby="new-key-title">
          <div className="section">
            <p className="banner-title" id="new-key-title">
              Copy your new API key now
            </p>
            <p className="muted">
              This is the only time it&apos;s shown. Store it somewhere safe,
              like your app&apos;s secret store.
            </p>
            <code className="secret-value" aria-label="New API key">
              {newKey}
            </code>
            <div className="row">
              <Button onClick={() => void copy()}>
                {copied ? "Copied" : "Copy API key"}
              </Button>
              <Button variant="ghost" onClick={() => setNewKey(undefined)}>
                Hide API key
              </Button>
            </div>
          </div>
        </section>
      )}

      {!isOwner && (
        <Banner title="Viewing as a member">
          Only workspace owners can create or revoke API keys.
        </Banner>
      )}

      {keys.status === "loading" && <Loading />}
      {keys.status === "error" && (
        <ErrorState error={keys.error} onRetry={keys.reload} />
      )}
      {keys.status === "ready" &&
        (keys.data.apiKeys.length === 0 ? (
          <EmptyState>
            No API keys yet.{" "}
            {isOwner
              ? "Create one to let an app call the public API."
              : "An owner can create one."}
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Prefix</th>
                  <th scope="col">Status</th>
                  <th scope="col">Created</th>
                  <th scope="col">Last used</th>
                  {isOwner && (
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {keys.data.apiKeys.map((key) => (
                  <tr key={key.id}>
                    <td data-label="Name">{key.name}</td>
                    <td data-label="Prefix">
                      <code>{key.prefix}</code>
                    </td>
                    <td data-label="Status">
                      {key.status === "active" ? (
                        <Status tone="success">Active</Status>
                      ) : (
                        <Status>Revoked</Status>
                      )}
                    </td>
                    <td data-label="Created">{formatDate(key.createdAt)}</td>
                    <td data-label="Last used">{formatDate(key.lastUsedAt)}</td>
                    {isOwner && (
                      <td className="actions">
                        {key.status === "active" && (
                          <Button
                            variant="danger"
                            onClick={() => setRevoking(key)}
                          >
                            Revoke key
                          </Button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

      <Dialog
        open={creating}
        title="Create API key"
        onClose={() => setCreating(false)}
      >
        <form
          className="form"
          onSubmit={(event) => void create(event)}
          noValidate
        >
          <Field
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            hint="For you to recognise it later, like ci-deploy."
            error={nameError}
            maxLength={100}
            autoFocus
          />
          <FormError error={failure} />
          <div className="form-actions">
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={busy}>
              {busy ? "Creating..." : "Create API key"}
            </Button>
          </div>
        </form>
      </Dialog>

      <ConfirmDialog
        open={revoking !== undefined}
        title="Revoke API key"
        confirmLabel="Revoke key"
        busyLabel="Revoking..."
        busy={busy}
        error={failure}
        onConfirm={() => void revoke()}
        onCancel={() => {
          setRevoking(undefined);
          setFailure(undefined);
        }}
      >
        <p>
          Apps using <strong>{revoking?.name}</strong> will get 401 from now on.
          This can&apos;t be undone.
        </p>
      </ConfirmDialog>
    </>
  );
}

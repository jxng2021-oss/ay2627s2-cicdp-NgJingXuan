"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import {
  Banner,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  Loading,
  PageHeader,
  formatDate,
} from "@/components/ui";
import { ApiError } from "@/lib/api/client";
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

export default function SecretPage() {
  const params = useParams<{ name: string }>();
  const name = decoded(params.name);
  const { id, isOwner, sealed, refresh } = useWorkspace();
  const toast = useToast();
  const router = useRouter();
  const versions = useLoad(() => api.secretVersions(id, name), [id, name]);
  const [value, setValue] = useState("");
  const [valueError, setValueError] = useState<string>();
  const [rotating, setRotating] = useState(false);
  const [rotateFailure, setRotateFailure] = useState<unknown>();
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleteFailure, setDeleteFailure] = useState<unknown>();
  const back = `/workspaces/${id}/secrets`;

  if (versions.status === "loading") return <Loading />;
  if (versions.status === "error") {
    if (versions.error instanceof ApiError && versions.error.status === 404) {
      return (
        <EmptyState>
          This secret doesn&apos;t exist.{" "}
          <Link href={back}>Back to secrets</Link>
        </EmptyState>
      );
    }
    return <ErrorState error={versions.error} onRetry={versions.reload} />;
  }

  const list = [...versions.data.versions].sort(
    (a, b) => b.version - a.version,
  );
  const latest = list[0];
  const first = list.at(-1);

  async function rotate(event: FormEvent) {
    event.preventDefault();
    if (!value) {
      setValueError("Enter the new value.");
      return;
    }
    setValueError(undefined);
    setRotating(true);
    setRotateFailure(undefined);
    try {
      await api.rotateSecret(id, name, value);
      setValue("");
      toast(`Secret ${name} rotated`);
      versions.reload();
      refresh();
    } catch (error) {
      setRotateFailure(error);
    } finally {
      setRotating(false);
    }
  }

  async function remove() {
    setBusy(true);
    setDeleteFailure(undefined);
    try {
      await api.deleteSecret(id, name);
      toast(`Secret ${name} deleted`);
      refresh();
      router.replace(back);
    } catch (error) {
      setDeleteFailure(error);
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        label="Secret"
        title={name}
        description="Write only: the value is encrypted and can never be read back. Apps use it through proxy connections."
        actions={
          <Link className="button" data-variant="ghost" href={back}>
            All secrets
          </Link>
        }
      />

      <div className="stats">
        <section className="card stat-tile" aria-label="Current version">
          <p className="sec-label">Current version</p>
          <p className="stat-value mono">v{latest?.version ?? "-"}</p>
        </section>
        <section className="card stat-tile" aria-label="Last rotated">
          <p className="sec-label">Last rotated</p>
          <p>{latest ? formatDate(latest.createdAt) : "-"}</p>
        </section>
        <section className="card stat-tile" aria-label="Created">
          <p className="sec-label">Created</p>
          <p>{first ? formatDate(first.createdAt) : "-"}</p>
        </section>
      </div>

      {isOwner ? (
        <Card title="Rotate secret">
          <form
            className="form"
            onSubmit={(event) => void rotate(event)}
            noValidate
          >
            <div className="stack-2">
              <h2>Rotate secret</h2>
              <p className="muted">
                Saves a new value as version {(latest?.version ?? 0) + 1}.
                Connections use it from their next call.
              </p>
            </div>
            <Field
              label="New value"
              type="password"
              autoComplete="off"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              error={valueError}
              disabled={sealed}
            />
            <FormError error={rotateFailure} />
            <div className="form-actions">
              <Button
                variant="primary"
                type="submit"
                disabled={rotating || sealed}
              >
                {rotating ? "Rotating..." : "Rotate secret"}
              </Button>
            </div>
          </form>
        </Card>
      ) : (
        <Banner title="Viewing as a member">
          Only workspace owners can rotate or delete secrets.
        </Banner>
      )}

      <Card title="Versions">
        <div className="section">
          <h2>Versions</h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Version</th>
                  <th scope="col">Saved</th>
                </tr>
              </thead>
              <tbody>
                {list.map((version) => (
                  <tr key={version.version}>
                    <td data-label="Version" className="mono">
                      v{version.version}
                      {version === latest && " (current)"}
                    </td>
                    <td data-label="Saved">{formatDate(version.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Card>

      {isOwner && (
        <Card title="Delete secret">
          <div className="section">
            <h2>Delete secret</h2>
            <p className="muted">
              Deletes every version. Apps and connections using it stop working.
            </p>
            <div>
              <Button variant="danger" onClick={() => setDeleting(true)}>
                Delete secret
              </Button>
            </div>
          </div>
        </Card>
      )}

      <ConfirmDialog
        open={deleting}
        title="Delete secret"
        confirmLabel="Delete secret"
        busyLabel="Deleting..."
        busy={busy}
        error={deleteFailure}
        onConfirm={() => void remove()}
        onCancel={() => {
          setDeleting(false);
          setDeleteFailure(undefined);
        }}
      >
        <p>
          <code>{name}</code> and every version of it will be deleted. Apps and
          proxy connections using it will stop working. This can&apos;t be
          undone.
        </p>
      </ConfirmDialog>
    </>
  );
}

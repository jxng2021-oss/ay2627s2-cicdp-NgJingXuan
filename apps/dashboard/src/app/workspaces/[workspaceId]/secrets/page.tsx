"use client";

import { useState, type FormEvent } from "react";
import {
  ArrowLink,
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  Loading,
  PageHeader,
  Pager,
  formatDate,
} from "@/components/ui";

import { workspace as api } from "@/lib/api/endpoints";
import { useToast } from "@/lib/toast";
import { useLoad } from "@/lib/use-load";
import { useWorkspace } from "@/lib/workspace";

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export default function SecretsPage() {
  const { id, isOwner, sealed, refresh } = useWorkspace();
  const toast = useToast();
  const [cursor, setCursor] = useState<string>();
  const list = useLoad(() => api.secrets(id, cursor), [id, cursor]);
  const [creating, setCreating] = useState(false);

  return (
    <>
      <PageHeader
        label="Workspace"
        title="Secrets"
        description="Write only: values are encrypted and can never be read back, by anyone. Apps use them through proxy connections. Forgot one? Rotate it."
        actions={
          isOwner && (
            <Button
              variant="primary"
              disabled={sealed}
              onClick={() => setCreating(true)}
            >
              Create secret
            </Button>
          )
        }
      />

      {list.status === "loading" && <Loading />}
      {list.status === "error" && (
        <ErrorState error={list.error} onRetry={list.reload} />
      )}
      {list.status === "ready" &&
        (list.data.secrets.length === 0 ? (
          <EmptyState>
            No secrets yet.{" "}
            {isOwner
              ? "Create one to store a password, token or key."
              : "An owner can create one."}
          </EmptyState>
        ) : (
          <div className="section">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Version</th>
                    <th scope="col">Updated</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.secrets.map((secret) => (
                    <tr key={secret.name}>
                      <td data-label="Name">
                        <code>{secret.name}</code>
                      </td>
                      <td data-label="Version" className="mono">
                        v{secret.latestVersion}
                      </td>
                      <td data-label="Updated">
                        {formatDate(secret.updatedAt)}
                      </td>
                      <td className="actions">
                        <ArrowLink
                          href={`/workspaces/${id}/secrets/${encodeURIComponent(secret.name)}`}
                          label={`Details of ${secret.name}`}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager
              next={list.data.nextCursor}
              onNext={setCursor}
              onFirst={cursor ? () => setCursor(undefined) : undefined}
            />
          </div>
        ))}

      {creating && (
        <CreateSecret
          onClose={() => setCreating(false)}
          onSaved={(name) => {
            toast(`Secret ${name} saved`);
            setCreating(false);
            list.reload();
            refresh();
          }}
        />
      )}
    </>
  );
}

function CreateSecret({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (name: string) => void;
}) {
  const { id } = useWorkspace();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [errors, setErrors] = useState<{ name?: string; value?: string }>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found: typeof errors = {};
    if (!NAME_PATTERN.test(name)) {
      found.name =
        "Use 1 to 128 letters, digits, dots, dashes or underscores, starting with a letter or digit.";
    }
    if (!value) found.value = "Enter the value to store.";
    setErrors(found);
    if (found.name || found.value) return;
    setBusy(true);
    setFailure(undefined);
    try {
      await api.saveSecret(id, name, value);
      setValue("");
      onSaved(name);
    } catch (error) {
      setFailure(error);
      setBusy(false);
    }
  }

  return (
    <Dialog open title="Create secret" onClose={onClose}>
      <form
        className="form"
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        <Field
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          hint="Saving an existing name adds a new version."
          error={errors.name}
          autoFocus
        />
        <Field
          label="Value"
          type="password"
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          error={errors.value}
        />
        <FormError error={failure} />
        <div className="form-actions">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={busy}>
            {busy ? "Saving..." : "Save secret"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

"use client";

import { useState, type FormEvent } from "react";
import { workspace as api } from "@/lib/api/endpoints";
import { Button, Dialog, Field, FormError } from "./ui";

export function DeleteWorkspaceDialog({
  id,
  name,
  finishing = false,
  onClose,
}: {
  id: string;
  name: string;
  finishing?: boolean;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const label = finishing ? "Finish deletion" : "Delete workspace";

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (typed !== name) {
      setError("Type the workspace's name exactly as shown.");
      return;
    }
    setError(undefined);
    setBusy(true);
    setFailure(undefined);
    try {
      await api.deleteWorkspace(id, typed);
      window.location.assign("/workspaces");
    } catch (problem) {
      setFailure(problem);
      setBusy(false);
    }
  }

  return (
    <Dialog open title={label} onClose={onClose}>
      <form
        className="form"
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        <p>
          This destroys the key of <strong>{name}</strong>: its secrets and
          files can never be decrypted again. This can&apos;t be undone.
        </p>
        <Field
          label="Workspace name"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          error={error}
          hint={`Type ${name} to confirm.`}
          autoComplete="off"
          autoFocus
        />
        <FormError error={failure} />
        <div className="form-actions">
          <Button variant="ghost" onClick={onClose}>
            Keep it
          </Button>
          <Button variant="danger" type="submit" disabled={busy}>
            {busy ? "Deleting..." : label}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

"use client";

import { useState } from "react";
import { DeleteWorkspaceDialog } from "@/components/delete-workspace";
import { Button, PageHeader } from "@/components/ui";
import { useWorkspace } from "@/lib/workspace";

export default function SettingsPage() {
  const { id, overview, isOwner } = useWorkspace();
  const [deleting, setDeleting] = useState(false);

  return (
    <>
      <PageHeader
        label="Workspace"
        title="Settings"
        description="This workspace's details."
      />
      <section className="card stack-2" aria-label="Details">
        <p className="sec-label">Name</p>
        <p>{overview.name}</p>
        <p className="sec-label">Workspace ID</p>
        <p>
          <code>{id}</code>
        </p>
      </section>
      <section className="card stack-2 danger-zone" aria-labelledby="danger">
        <h2 id="danger">Delete workspace</h2>
        <p className="muted">
          Destroys the workspace&apos;s encryption key first, so its secrets and
          files can never be decrypted again, even from a backup copy. Then its
          files, connections and API keys are removed and everyone loses access.
          This can&apos;t be undone.
        </p>
        {isOwner ? (
          <div>
            <Button variant="danger" onClick={() => setDeleting(true)}>
              Delete workspace
            </Button>
          </div>
        ) : (
          <p className="muted">Only an owner can delete the workspace.</p>
        )}
      </section>
      {deleting && (
        <DeleteWorkspaceDialog
          id={id}
          name={overview.name}
          onClose={() => setDeleting(false)}
        />
      )}
    </>
  );
}

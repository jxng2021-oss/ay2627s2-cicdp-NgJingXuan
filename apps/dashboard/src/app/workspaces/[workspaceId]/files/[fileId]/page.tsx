"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
  ShortValue,
  formatBytes,
  formatDate,
} from "@/components/ui";
import { ApiError } from "@/lib/api/client";
import { workspace as api } from "@/lib/api/endpoints";
import { useToast } from "@/lib/toast";
import { useLoad } from "@/lib/use-load";
import { useWorkspace } from "@/lib/workspace";

export default function FilePage() {
  const { fileId } = useParams<{ fileId: string }>();
  const { id, isOwner, sealed, refresh } = useWorkspace();
  const toast = useToast();
  const router = useRouter();
  const file = useLoad(() => api.fileMetadata(id, fileId), [id, fileId]);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const back = `/workspaces/${id}/files`;

  if (file.status === "loading") return <Loading />;
  if (file.status === "error") {
    if (file.error instanceof ApiError && file.error.status === 404) {
      return (
        <EmptyState>
          This file doesn&apos;t exist. <Link href={back}>Back to files</Link>
        </EmptyState>
      );
    }
    return <ErrorState error={file.error} onRetry={file.reload} />;
  }
  const info = file.data;
  const label = info.name ?? "Unnamed file";

  async function remove() {
    setBusy(true);
    setFailure(undefined);
    try {
      await api.deleteFile(id, fileId);
      toast(`File ${label} deleted`);
      refresh();
      router.replace(back);
    } catch (error) {
      setFailure(error);
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        label="File"
        title={label}
        description="Stored encrypted: each file has its own key, protected by the workspace's key."
        actions={
          <Link className="button" data-variant="ghost" href={back}>
            All files
          </Link>
        }
      />

      <Card title="Details">
        <div className="section">
          <div className="row row-between">
            <h2>Details</h2>
            {sealed ? (
              <Button disabled>Download file</Button>
            ) : (
              <a
                className="button"
                data-variant="primary"
                href={api.downloadUrl(id, info.id)}
                download
              >
                Download file
              </a>
            )}
          </div>
          <dl className="details-grid">
            <dt>Name</dt>
            <dd>{info.name ?? <span className="muted">Unnamed</span>}</dd>
            <dt>File ID</dt>
            <dd>
              <ShortValue value={info.id} label="file ID" />
            </dd>
            <dt>Type</dt>
            <dd className="mono">{info.contentType}</dd>
            <dt>Size</dt>
            <dd className="mono">{formatBytes(info.size)}</dd>
            <dt>Uploaded</dt>
            <dd>{formatDate(info.createdAt)}</dd>
          </dl>
          {sealed && (
            <p className="muted">
              Downloads are unavailable while the secrets service is sealed.
            </p>
          )}
        </div>
      </Card>

      {isOwner && (
        <Card title="Delete file">
          <div className="section">
            <h2>Delete file</h2>
            <p className="muted">
              Its key is destroyed first, then its data: it can&apos;t be
              recovered, even from a copy.
            </p>
            <div>
              <Button variant="danger" onClick={() => setDeleting(true)}>
                Delete file
              </Button>
            </div>
          </div>
        </Card>
      )}

      <ConfirmDialog
        open={deleting}
        title="Delete file"
        confirmLabel="Delete file"
        busyLabel="Deleting..."
        busy={busy}
        error={failure}
        onConfirm={() => void remove()}
        onCancel={() => {
          setDeleting(false);
          setFailure(undefined);
        }}
      >
        <p>
          <span className="mono">{label}</span> will be deleted for good. This
          can&apos;t be undone.
        </p>
      </ConfirmDialog>
    </>
  );
}

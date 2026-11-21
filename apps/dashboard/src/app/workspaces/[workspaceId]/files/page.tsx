"use client";

import { useRef, useState, type ChangeEvent } from "react";
import {
  ArrowLink,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
  Pager,
  formatBytes,
  formatDate,
} from "@/components/ui";
import { workspace as api } from "@/lib/api/endpoints";
import { useToast } from "@/lib/toast";
import { useLoad } from "@/lib/use-load";
import { useWorkspace } from "@/lib/workspace";

export default function FilesPage() {
  const { id, sealed, refresh } = useWorkspace();
  const toast = useToast();
  const [cursor, setCursor] = useState<string>();
  const files = useLoad(() => api.files(id, cursor), [id, cursor]);
  const usage = useLoad(() => api.usage(id), [id]);
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<{
    name: string;
    fraction: number;
  }>();
  const [uploadFailure, setUploadFailure] = useState<unknown>();

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setUploadFailure(undefined);
    setProgress({ name: file.name, fraction: 0 });
    try {
      await api.uploadFile(id, file, (fraction) =>
        setProgress({ name: file.name, fraction }),
      );
      toast(`File ${file.name} uploaded`);
      files.reload();
      usage.reload();
      refresh();
    } catch (error) {
      setUploadFailure(error);
    } finally {
      setProgress(undefined);
    }
  }

  const percent = progress ? Math.round(progress.fraction * 100) : 0;

  return (
    <>
      <PageHeader
        label="Workspace"
        title="Files"
        description="Files are encrypted before they're stored."
        actions={
          <>
            <input
              ref={input}
              type="file"
              className="sr-only"
              id="file-upload"
              onChange={(event) => void upload(event)}
              disabled={sealed || progress !== undefined}
              tabIndex={-1}
              aria-hidden="true"
            />
            <Button
              variant="primary"
              disabled={sealed || progress !== undefined}
              onClick={() => input.current?.click()}
            >
              {progress ? "Uploading..." : "Upload file"}
            </Button>
          </>
        }
      />

      {usage.status === "ready" && (
        <Card title="Storage">
          <div className="stack-2">
            <p className="sec-label">Storage</p>
            <p>
              <span className="mono">{formatBytes(usage.data.usedBytes)}</span>{" "}
              <span className="muted">
                of {formatBytes(usage.data.limitBytes)} used
              </span>
            </p>
            <div
              className="progress"
              role="meter"
              data-level={storageLevel(
                usage.data.usedBytes,
                usage.data.limitBytes,
              )}
              aria-label="Storage used"
              aria-valuemin={0}
              aria-valuemax={usage.data.limitBytes}
              aria-valuenow={usage.data.usedBytes}
            >
              <span
                style={{
                  width: `${Math.min(100, (usage.data.usedBytes / Math.max(1, usage.data.limitBytes)) * 100)}%`,
                }}
              />
            </div>
          </div>
        </Card>
      )}

      {progress && (
        <div className="stack-2" aria-live="polite">
          <p>
            Uploading <span className="mono">{progress.name}</span>...{" "}
            <span className="mono">{percent}%</span>
          </p>
          <div
            className="progress"
            role="progressbar"
            aria-label="Upload progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <span style={{ width: `${percent}%` }} />
          </div>
        </div>
      )}
      {uploadFailure !== undefined && <ErrorState error={uploadFailure} />}

      {files.status === "loading" && <Loading />}
      {files.status === "error" && (
        <ErrorState error={files.error} onRetry={files.reload} />
      )}
      {files.status === "ready" &&
        (files.data.files.length === 0 ? (
          <EmptyState>
            No files yet. Upload one to store it encrypted.
          </EmptyState>
        ) : (
          <div className="section">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Type</th>
                    <th scope="col">Size</th>
                    <th scope="col">Uploaded</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {files.data.files.map((file) => (
                    <tr key={file.id}>
                      <td data-label="Name">
                        {file.name ?? <span className="muted">Unnamed</span>}
                      </td>
                      <td data-label="Type" className="mono">
                        {file.contentType}
                      </td>
                      <td data-label="Size" className="mono">
                        {formatBytes(file.size)}
                      </td>
                      <td data-label="Uploaded">
                        {formatDate(file.createdAt)}
                      </td>
                      <td className="actions">
                        <ArrowLink
                          href={`/workspaces/${id}/files/${file.id}`}
                          label={`Details of ${file.name ?? file.id}`}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager
              next={files.data.nextCursor}
              onNext={setCursor}
              onFirst={cursor ? () => setCursor(undefined) : undefined}
            />
          </div>
        ))}
    </>
  );
}

function storageLevel(used: number, limit: number): "ok" | "high" | "full" {
  const share = used / Math.max(1, limit);
  return share >= 0.95 ? "full" : share >= 0.8 ? "high" : "ok";
}

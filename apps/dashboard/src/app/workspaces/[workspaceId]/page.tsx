"use client";

import { WorkspaceAnalytics } from "@/components/analytics";
import { Card, PageHeader, Status, formatBytes } from "@/components/ui";
import { useWorkspace } from "@/lib/workspace";

export default function OverviewPage() {
  const { id, overview, sealed } = useWorkspace();
  const storage = overview.storage;
  const stat = (value: number | null | undefined) =>
    value === null || value === undefined ? "—" : String(value);
  return (
    <>
      <PageHeader
        label="Workspace"
        title={overview.name}
        description="Your workspace at a glance."
      />
      <div className="stats">
        <Card title="Your role">
          <p className="sec-label">Your role</p>
          <p className="stat-value">
            {overview.role === "owner" ? "Owner" : "Member"}
          </p>
        </Card>
        <Card title="Secrets">
          <p className="sec-label">Secrets</p>
          <p className="stat-value">{stat(overview.secretsCount)}</p>
          {overview.secretsCount === null && (
            <p className="muted">Unavailable while sealed</p>
          )}
        </Card>
        <Card title="Files">
          <p className="sec-label">Files</p>
          <p className="stat-value">{stat(overview.fileCount)}</p>
        </Card>
        <Card title="Storage">
          <p className="sec-label">Storage</p>
          <p className="stat-value">
            {storage ? formatBytes(storage.usedBytes) : "—"}
          </p>
          {storage && (
            <p className="muted">of {formatBytes(storage.limitBytes)}</p>
          )}
        </Card>
        <Card title="Secrets service">
          <p className="sec-label">Secrets service</p>
          <p className="stat-status">
            {overview.secretsSealed === null ? (
              <Status>Unknown</Status>
            ) : sealed ? (
              <Status tone="danger">Sealed</Status>
            ) : (
              <Status tone="success">Unsealed</Status>
            )}
          </p>
        </Card>
      </div>
      <WorkspaceAnalytics workspaceId={id} />
    </>
  );
}

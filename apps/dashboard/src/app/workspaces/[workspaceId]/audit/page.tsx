"use client";

import Link from "next/link";
import { AuditLog } from "@/components/audit-log";
import { PageHeader } from "@/components/ui";
import type { AuditEvent } from "@/lib/api/client";
import { workspace as api } from "@/lib/api/endpoints";
import { useWorkspace } from "@/lib/workspace";

const ACTIONS = [
  "user.signed_up",
  "user.logged_in",
  "user.login_failed",
  "user.logged_out",
  "user.password_changed",
  "membership.added",
  "membership.removed",
  "user.profile_updated",
  "user.session_revoked",
  "user.deleted",
  "api_key.created",
  "api_key.revoked",
  "api_key.deleted",
  "secret.created",
  "secret.read",
  "secret.rotated",
  "secret.revealed",
  "secret.deleted",
  "file.uploaded",
  "file.downloaded",
  "file.deleted",
  "proxy_connection.created",
  "proxy_connection.updated",
  "proxy_connection.deleted",
  "proxy_connection.used",
  "proxy_connection.denied",
  "tenant.created",
  "tenant.suspended",
  "user_pool.created",
  "user_pool.updated",
  "user_pool.deleted",
  "feature_flag.created",
  "feature_flag.updated",
  "feature_flag.toggled",
  "feature_flag.deleted",
  "webhook_endpoint.created",
  "webhook_endpoint.updated",
  "webhook_endpoint.deleted",
] as const satisfies readonly AuditEvent["action"][];
const RESOURCES = [
  "user",
  "membership",
  "api_key",
  "secret",
  "file",
  "proxy_connection",
  "tenant",
  "user_pool",
  "feature_flag",
  "webhook_endpoint",
] as const satisfies readonly AuditEvent["resourceType"][];

export default function AuditPage() {
  const { id } = useWorkspace();
  return (
    <>
      <PageHeader
        label="Workspace"
        title="Audit log"
        description="Every sensitive action in this workspace, in a log that shows any edit. Never values, keys or file contents."
      />
      <p className="muted">
        What happens to a user pool&apos;s users is in its own log:{" "}
        <Link href={`/workspaces/${id}/user-logs`}>User activity</Link>.
      </p>
      <AuditLog
        id="audit"
        label="Audit log"
        actions={ACTIONS}
        resources={RESOURCES}
        load={(query) => api.auditEvents(id, query)}
        dependsOn={[id]}
      />
    </>
  );
}

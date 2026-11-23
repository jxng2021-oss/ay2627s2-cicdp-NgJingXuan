"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { AuditLog } from "@/components/audit-log";
import { EmptyState, ErrorState, Loading, PageHeader } from "@/components/ui";
import type { PoolAuditEvent } from "@/lib/api/client";
import { workspace as api } from "@/lib/api/endpoints";
import { useLoad } from "@/lib/use-load";
import { useWorkspace } from "@/lib/workspace";

const ACTIONS = [
  "pool_user.signed_up",
  "pool_user.logged_in",
  "pool_user.login_failed",
  "pool_user.logged_out",
  "pool_user.token_reused",
  "pool_user.password_reset",
  "pool_user.password_changed",
  "pool_user.unlocked",
  "pool_user.updated",
  "pool_user.deleted",
  "pool_user.role_added",
  "pool_user.role_removed",
  "pool_role.created",
  "pool_role.updated",
  "pool_role.deleted",
] as const satisfies readonly PoolAuditEvent["action"][];
const RESOURCES = [
  "pool_user",
  "pool_role",
] as const satisfies readonly PoolAuditEvent["resourceType"][];

export default function UserLogsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <UserLogs />
    </Suspense>
  );
}

function UserLogs() {
  const { id } = useWorkspace();
  const router = useRouter();
  const pathname = usePathname();
  const selected = useSearchParams().get("pool") ?? "";
  const pools = useLoad(() => api.pools(id), [id]);

  function choose(poolId: string) {
    router.replace(
      poolId ? `${pathname}?pool=${encodeURIComponent(poolId)}` : pathname,
    );
  }

  const header = (
    <PageHeader
      label="User pools"
      title="User logs"
      description="Each user pool's own tamper-evident log: sign ups, sign ins, lockouts, password resets and role changes. Kept apart from the workspace's audit log."
    />
  );

  if (pools.status === "loading")
    return (
      <>
        {header}
        <Loading />
      </>
    );
  if (pools.status === "error")
    return (
      <>
        {header}
        <ErrorState error={pools.error} onRetry={pools.reload} />
      </>
    );
  if (pools.data.pools.length === 0)
    return (
      <>
        {header}
        <EmptyState>
          No user pools yet.{" "}
          <Link href={`/workspaces/${id}/user-pools`}>Create one</Link> to see
          its users&apos; activity here.
        </EmptyState>
      </>
    );
  const pool = pools.data.pools.find((entry) => entry.id === selected);

  return (
    <>
      {header}
      <div className="card form">
        <div className="field">
          <label htmlFor="user-logs-pool">User pool</label>
          <select
            id="user-logs-pool"
            className="select"
            value={pool ? pool.id : ""}
            onChange={(event) => choose(event.target.value)}
          >
            <option value="">Choose a user pool</option>
            {pools.data.pools.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      {pool ? (
        <AuditLog
          key={pool.id}
          id="user-logs"
          label={`${pool.name} log`}
          actions={ACTIONS}
          resources={RESOURCES}
          load={(query) => api.poolAuditEvents(id, pool.id, query)}
          dependsOn={[id, pool.id]}
        />
      ) : (
        <EmptyState>Choose a user pool to see its log.</EmptyState>
      )}
    </>
  );
}

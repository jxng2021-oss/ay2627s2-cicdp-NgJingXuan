"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import {
  Banner,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
  ShortValue,
  formatDate,
} from "@/components/ui";
import { UserRoles } from "@/components/pool-roles";
import { PoolUserStatus } from "@/components/pool-user-status";
import { ApiError } from "@/lib/api/client";
import { workspace as api } from "@/lib/api/endpoints";
import { useToast } from "@/lib/toast";
import { useLoad } from "@/lib/use-load";
import { useWorkspace } from "@/lib/workspace";

type Pending = "disable" | "enable" | "unlock" | "reset" | "delete";

export default function PoolUserPage() {
  const { poolId, userId } = useParams<{ poolId: string; userId: string }>();
  const { id, isOwner } = useWorkspace();
  const toast = useToast();
  const router = useRouter();
  const user = useLoad(
    () => api.poolUser(id, poolId, userId),
    [id, poolId, userId],
  );
  const [pending, setPending] = useState<Pending>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const back = `/workspaces/${id}/user-pools/${poolId}`;

  if (user.status === "loading") return <Loading />;
  if (user.status === "error") {
    if (user.error instanceof ApiError && user.error.status === 404) {
      return (
        <EmptyState>
          This user doesn&apos;t exist.{" "}
          <Link href={back}>Back to the user pool</Link>
        </EmptyState>
      );
    }
    return <ErrorState error={user.error} onRetry={user.reload} />;
  }
  const info = user.data;

  function close() {
    setPending(undefined);
    setFailure(undefined);
    setBusy(false);
  }

  async function confirm() {
    setBusy(true);
    setFailure(undefined);
    try {
      if (pending === "disable" || pending === "enable") {
        const status = pending === "enable" ? "active" : "disabled";
        await api.setPoolUserStatus(id, poolId, userId, status);
        toast(`${info.email} ${pending === "enable" ? "enabled" : "disabled"}`);
        user.reload();
      } else if (pending === "unlock") {
        await api.unlockPoolUser(id, poolId, userId);
        toast(`${info.email} unlocked`);
        user.reload();
      } else if (pending === "reset") {
        await api.resetPoolUserPassword(id, poolId, userId);
        toast(`${info.email} must choose a new password at their next sign in`);
        user.reload();
      } else if (pending === "delete") {
        await api.deletePoolUser(id, poolId, userId);
        toast(`${info.email} deleted`);
        router.replace(back);
        return;
      }
      close();
    } catch (error) {
      setFailure(error);
      setBusy(false);
    }
  }

  const dialog: Record<Pending, { title: string; text: string }> = {
    disable: {
      title: "Disable user",
      text: "They can't sign in, and their sessions end, until you enable them again.",
    },
    enable: {
      title: "Enable user",
      text: "They can sign in again.",
    },
    unlock: {
      title: "Unlock user",
      text: "They can sign in again straight away instead of waiting for the lock to end.",
    },
    reset: {
      title: "Reset password",
      text: "They are signed out everywhere. They sign in with their current password and your app then asks them to choose a new one.",
    },
    delete: {
      title: "Delete user",
      text: "They and their sessions are deleted. This can't be undone.",
    },
  };
  const attributes = Object.entries(info.attributes);

  return (
    <>
      <PageHeader
        label="Pool user"
        title={info.email}
        actions={
          <Link className="button" data-variant="ghost" href={back}>
            Back to pool
          </Link>
        }
      />

      <Card title="Details">
        <div className="section">
          <h2>Details</h2>
          <dl className="details-grid">
            <dt>Status</dt>
            <dd>
              <PoolUserStatus user={info} />
            </dd>
            <dt>User ID</dt>
            <dd>
              <ShortValue value={info.id} label="user ID" />
            </dd>
            <dt>Last sign in</dt>
            <dd>{formatDate(info.lastLoginAt)}</dd>
            <dt>Created</dt>
            <dd>{formatDate(info.createdAt)}</dd>
            <dt>Attributes</dt>
            <dd>
              {attributes.length === 0 ? (
                <span className="muted">None</span>
              ) : (
                <span className="stack-2">
                  {attributes.map(([key, value]) => (
                    <code key={key}>
                      {key} = {String(value)}
                    </code>
                  ))}
                </span>
              )}
            </dd>
          </dl>
        </div>
      </Card>

      <UserRoles
        poolId={poolId}
        userId={userId}
        email={info.email}
        roles={info.roles}
        onChanged={user.reload}
      />

      {isOwner ? (
        <Card title="Manage user">
          <div className="section">
            <h2>Manage user</h2>
            <div className="row">
              {info.status === "active" ? (
                <Button onClick={() => setPending("disable")}>
                  Disable user
                </Button>
              ) : (
                <Button onClick={() => setPending("enable")}>
                  Enable user
                </Button>
              )}
              {info.locked && (
                <Button onClick={() => setPending("unlock")}>
                  Unlock user
                </Button>
              )}
              <Button
                onClick={() => setPending("reset")}
                disabled={info.passwordResetRequired}
              >
                {info.passwordResetRequired
                  ? "Password reset pending"
                  : "Reset password"}
              </Button>
              <Button variant="danger" onClick={() => setPending("delete")}>
                Delete user
              </Button>
            </div>
          </div>
        </Card>
      ) : (
        <Banner title="Viewing as a member">
          Only workspace owners can manage users.
        </Banner>
      )}

      <ConfirmDialog
        open={pending !== undefined}
        title={pending ? dialog[pending].title : ""}
        confirmLabel={pending ? dialog[pending].title : ""}
        busyLabel="Working..."
        busy={busy}
        error={failure}
        onConfirm={() => void confirm()}
        onCancel={close}
      >
        <p>
          <strong>{info.email}</strong>: {pending ? dialog[pending].text : ""}
        </p>
      </ConfirmDialog>
    </>
  );
}

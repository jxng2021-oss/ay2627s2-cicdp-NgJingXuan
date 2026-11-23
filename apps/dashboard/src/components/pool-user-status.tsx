import { Status } from "@/components/ui";
import type { PoolUser } from "@/lib/api/client";

export function PoolUserStatus({
  user,
}: {
  user: Pick<PoolUser, "status" | "locked" | "passwordResetRequired">;
}) {
  return (
    <span className="row">
      {user.status === "disabled" ? (
        <Status tone="warning">Disabled</Status>
      ) : user.locked ? (
        <Status tone="danger">Locked</Status>
      ) : (
        <Status tone="success">Active</Status>
      )}
      {user.passwordResetRequired && (
        <Status tone="info">Password reset pending</Status>
      )}
    </span>
  );
}

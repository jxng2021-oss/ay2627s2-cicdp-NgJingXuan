"use client";

import { useId, useState, type FormEvent } from "react";
import {
  Button,
  Card,
  ConfirmDialog,
  Dialog,
  ErrorState,
  Field,
  FormError,
  Loading,
} from "@/components/ui";
import { ApiError, type PoolRole } from "@/lib/api/client";
import { workspace as api } from "@/lib/api/endpoints";
import { useToast } from "@/lib/toast";
import { useLoad } from "@/lib/use-load";
import { useWorkspace } from "@/lib/workspace";

const ROLE_NAME = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
const PERMISSION = /^(\*|[A-Za-z0-9][A-Za-z0-9_.:-]{0,98}(:\*|\.\*)?)$/;

function parsePermissions(text: string): string[] | string {
  const list = [
    ...new Set(
      text
        .split(/[\n,]/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
  const bad = list.find((permission) => !PERMISSION.test(permission));
  if (bad) {
    return `"${bad}" isn't a permission. Use letters, digits, dots, colons, dashes or underscores, like orders:refund (orders:* for all of them).`;
  }
  if (list.length > 100) return "Use at most 100 permissions.";
  return list;
}

export function PoolRoles({ poolId }: { poolId: string }) {
  const { id, isOwner } = useWorkspace();
  const toast = useToast();
  const roles = useLoad(() => api.poolRoles(id, poolId), [id, poolId]);
  const [editing, setEditing] = useState<PoolRole | "new">();
  const [deleting, setDeleting] = useState<PoolRole>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>();

  async function remove() {
    if (!deleting) return;
    setBusy(true);
    setFailure(undefined);
    try {
      await api.deletePoolRole(id, poolId, deleting.name);
      toast(`Role ${deleting.name} deleted`);
      setDeleting(undefined);
      roles.reload();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Roles">
      <div className="section">
        <div className="row row-between">
          <div className="stack-2">
            <h2>Roles</h2>
            <p className="muted">
              Name what users may do in your app, like{" "}
              <code>orders:refund</code>, and give users roles. Their roles and
              permissions are in their access token, so your app checks them
              without asking us.
            </p>
          </div>
          {isOwner && (
            <Button variant="primary" onClick={() => setEditing("new")}>
              Create role
            </Button>
          )}
        </div>
        {roles.status === "loading" && <Loading />}
        {roles.status === "error" && (
          <ErrorState error={roles.error} onRetry={roles.reload} />
        )}
        {roles.status === "ready" &&
          (roles.data.roles.length === 0 ? (
            <p className="muted">
              No roles yet.{" "}
              {isOwner
                ? "Create one, then give it to users on their page."
                : "An owner can create one."}
            </p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Role</th>
                    <th scope="col">Permissions</th>
                    <th scope="col">Users</th>
                    {isOwner && (
                      <th scope="col">
                        <span className="sr-only">Actions</span>
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {roles.data.roles.map((role) => (
                    <tr key={role.name}>
                      <td data-label="Role">
                        <span className="stack-2">
                          <code>{role.name}</code>
                          {role.description && (
                            <span className="muted">{role.description}</span>
                          )}
                        </span>
                      </td>
                      <td data-label="Permissions">
                        {role.permissions.length === 0 ? (
                          <span className="muted">None</span>
                        ) : (
                          <span className="permission-list">
                            {role.permissions.map((permission) => (
                              <code key={permission}>{permission}</code>
                            ))}
                          </span>
                        )}
                      </td>
                      <td data-label="Users" className="mono">
                        {role.userCount}
                      </td>
                      {isOwner && (
                        <td className="actions">
                          <div className="row">
                            <Button
                              variant="ghost"
                              aria-label={`Edit role ${role.name}`}
                              onClick={() => setEditing(role)}
                            >
                              Edit
                            </Button>
                            <Button
                              variant="ghost"
                              aria-label={`Delete role ${role.name}`}
                              onClick={() => setDeleting(role)}
                            >
                              Delete
                            </Button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
      </div>

      {editing && (
        <RoleForm
          poolId={poolId}
          existing={editing === "new" ? undefined : editing}
          onClose={() => setEditing(undefined)}
          onSaved={(name, created) => {
            toast(created ? `Role ${name} created` : `Role ${name} saved`);
            setEditing(undefined);
            roles.reload();
          }}
        />
      )}
      <ConfirmDialog
        open={deleting !== undefined}
        title="Delete role"
        confirmLabel="Delete role"
        busyLabel="Deleting..."
        busy={busy}
        error={failure}
        onConfirm={() => void remove()}
        onCancel={() => {
          setDeleting(undefined);
          setFailure(undefined);
        }}
      >
        <p>
          <code>{deleting?.name}</code> is deleted and taken from its{" "}
          {deleting?.userCount ?? 0}{" "}
          {deleting?.userCount === 1 ? "user" : "users"}, from their next access
          token. This can&apos;t be undone.
        </p>
      </ConfirmDialog>
    </Card>
  );
}

function RoleForm({
  poolId,
  existing,
  onClose,
  onSaved,
}: {
  poolId: string;
  existing?: PoolRole;
  onClose: () => void;
  onSaved: (name: string, created: boolean) => void;
}) {
  const { id } = useWorkspace();
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [permissions, setPermissions] = useState(
    existing?.permissions.join("\n") ?? "",
  );
  const [errors, setErrors] = useState<{ name?: string; permissions?: string }>(
    {},
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const permissionsId = useId();

  async function save(event: FormEvent) {
    event.preventDefault();
    const found: typeof errors = {};
    if (!existing && !ROLE_NAME.test(name)) {
      found.name =
        "Use 1 to 64 lowercase letters, digits, dots, colons, dashes or underscores, like support.";
    }
    const list = parsePermissions(permissions);
    if (typeof list === "string") found.permissions = list;
    setErrors(found);
    if (found.name || found.permissions || typeof list === "string") return;
    setBusy(true);
    setFailure(undefined);
    try {
      if (existing) {
        await api.updatePoolRole(id, poolId, existing.name, {
          description: description.trim(),
          permissions: list,
        });
      } else {
        await api.createPoolRole(id, poolId, {
          name,
          description: description.trim(),
          permissions: list,
        });
      }
      onSaved(existing?.name ?? name, !existing);
    } catch (error) {
      if (error instanceof ApiError && error.code === "CONFLICT") {
        setErrors({ name: error.message });
      } else {
        setFailure(error);
      }
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title={existing ? `Edit role ${existing.name}` : "Create role"}
      onClose={onClose}
    >
      <form className="form" onSubmit={(event) => void save(event)} noValidate>
        {!existing && (
          <Field
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            hint="What your app checks, like support or admin. Can't be changed later."
            error={errors.name}
            maxLength={64}
            autoFocus
          />
        )}
        <Field
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          hint="Optional: who gets this role."
          maxLength={200}
        />
        <div className="field">
          <label htmlFor={permissionsId}>Permissions</label>
          <textarea
            id={permissionsId}
            className="textarea mono"
            rows={5}
            value={permissions}
            onChange={(e) => setPermissions(e.target.value)}
            placeholder={"orders:read\norders:refund"}
            aria-invalid={errors.permissions ? true : undefined}
            aria-describedby={`${permissionsId}-hint${errors.permissions ? ` ${permissionsId}-error` : ""}`}
          />
          <p className="hint" id={`${permissionsId}-hint`}>
            One per line. orders:* gives everything under orders; * gives
            everything.
          </p>
          {errors.permissions && (
            <p className="field-error" id={`${permissionsId}-error`}>
              {errors.permissions}
            </p>
          )}
        </div>
        <FormError error={failure} />
        <div className="form-actions">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={busy}>
            {busy ? "Saving..." : existing ? "Save role" : "Create role"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function UserRoles({
  poolId,
  userId,
  email,
  roles,
  onChanged,
}: {
  poolId: string;
  userId: string;
  email: string;
  roles: string[];
  onChanged: () => void;
}) {
  const { id, isOwner } = useWorkspace();
  const toast = useToast();
  const all = useLoad(() => api.poolRoles(id, poolId), [id, poolId]);
  const [choice, setChoice] = useState("");
  const [removing, setRemoving] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const selectId = useId();

  const others =
    all.status === "ready"
      ? all.data.roles.filter((role) => !roles.includes(role.name))
      : [];
  const permissions =
    all.status === "ready"
      ? [
          ...new Set(
            all.data.roles
              .filter((role) => roles.includes(role.name))
              .flatMap((role) => role.permissions),
          ),
        ].sort()
      : [];

  async function give(event: FormEvent) {
    event.preventDefault();
    if (!choice) return;
    setBusy(true);
    setFailure(undefined);
    try {
      await api.addPoolUserRole(id, poolId, userId, choice);
      toast(`${email} now has the ${choice} role`);
      setChoice("");
      onChanged();
      all.reload();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  async function take() {
    if (!removing) return;
    setBusy(true);
    setFailure(undefined);
    try {
      await api.removePoolUserRole(id, poolId, userId, removing);
      toast(`Role ${removing} taken from ${email}`);
      setRemoving(undefined);
      onChanged();
      all.reload();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Roles">
      <div className="section">
        <h2>Roles</h2>
        <p className="muted">
          Changes reach the user&apos;s next access token (at the latest when
          the current one expires).
        </p>
        {roles.length === 0 ? (
          <p className="muted">No roles.</p>
        ) : (
          <ul className="role-chips" aria-label="The user's roles">
            {roles.map((role) => (
              <li key={role} className="pill">
                <code>{role}</code>
                {isOwner && (
                  <button
                    type="button"
                    className="role-chip-remove"
                    aria-label={`Take the ${role} role`}
                    onClick={() => setRemoving(role)}
                  >
                    ×
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {permissions.length > 0 && (
          <p className="muted">
            Permissions:{" "}
            <span className="permission-list">
              {permissions.map((permission) => (
                <code key={permission}>{permission}</code>
              ))}
            </span>
          </p>
        )}
        {isOwner && all.status === "ready" && (
          <form className="search-form" onSubmit={(event) => void give(event)}>
            <div className="field">
              <label htmlFor={selectId}>Give a role</label>
              <select
                id={selectId}
                className="select"
                value={choice}
                onChange={(e) => setChoice(e.target.value)}
                disabled={others.length === 0}
              >
                <option value="">
                  {others.length === 0
                    ? all.data.roles.length === 0
                      ? "Create a role on the pool's page first"
                      : "The user has every role"
                    : "Choose a role"}
                </option>
                {others.map((role) => (
                  <option key={role.name} value={role.name}>
                    {role.name}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" disabled={busy || !choice}>
              Give role
            </Button>
          </form>
        )}
        {removing === undefined && <FormError error={failure} />}
      </div>
      <ConfirmDialog
        open={removing !== undefined}
        title="Take role"
        confirmLabel="Take role"
        busyLabel="Taking..."
        busy={busy}
        error={failure}
        onConfirm={() => void take()}
        onCancel={() => {
          setRemoving(undefined);
          setFailure(undefined);
        }}
      >
        <p>
          <strong>{email}</strong> loses the <code>{removing}</code> role and
          its permissions, from their next access token.
        </p>
      </ConfirmDialog>
    </Card>
  );
}

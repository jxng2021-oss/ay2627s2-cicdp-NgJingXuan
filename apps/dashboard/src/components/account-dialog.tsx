"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useId,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Button,
  ConfirmDialog,
  Dialog,
  ErrorState,
  Field,
  FormError,
  Loading,
  Status,
  formatDate,
} from "@/components/ui";
import {
  ApiError,
  type Me,
  type SessionInfo,
  type WorkspaceSummary,
} from "@/lib/api/client";
import { account, auth } from "@/lib/api/endpoints";
import { useMarkSignedIn } from "@/lib/session";
import { useToast } from "@/lib/toast";
import { useLoad } from "@/lib/use-load";

const MIN_PASSWORD = 12;

const TABS = [
  ["profile", "Profile"],
  ["password", "Password"],
  ["sessions", "Sessions"],
  ["workspaces", "Workspaces"],
  ["delete", "Delete account"],
] as const;
type Tab = (typeof TABS)[number][0];

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="account-panel" aria-label={title}>
      {children}
    </section>
  );
}

export function AccountDialog({
  me,
  open,
  onClose,
  onChanged,
}: {
  me: Me;
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<Tab>("profile");
  const baseId = useId();
  const tabs = TABS.filter(
    ([value]) => value !== "password" || me.user.hasPassword,
  );
  useEffect(() => {
    if (open) setTab("profile");
  }, [open]);

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const index = tabs.findIndex(([value]) => value === tab);
    const step =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = tabs[(index + step + tabs.length) % tabs.length]![0];
    setTab(next);
    document.getElementById(`${baseId}-${next}-tab`)?.focus();
  }

  return (
    <Dialog open={open} title="Your account" onClose={onClose} size="lg">
      <p className="muted">
        {me.user.email} · member since {formatDate(me.user.createdAt)}
      </p>
      <div
        className="account-tabs"
        role="tablist"
        aria-label="Account"
        onKeyDown={onKeyDown}
      >
        {tabs.map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={`${baseId}-${value}-tab`}
            aria-selected={tab === value}
            aria-controls={`${baseId}-${value}`}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${baseId}-${tab}`}
        aria-labelledby={`${baseId}-${tab}-tab`}
        className="account-tabpanel"
      >
        {tab === "profile" && <Profile me={me} onSaved={onChanged} />}
        {tab === "password" && <ChangePassword />}
        {tab === "sessions" && <Sessions />}
        {tab === "workspaces" && (
          <Workspaces workspaces={me.workspaces} onLeft={onChanged} />
        )}
        {tab === "delete" && <DeleteAccount me={me} />}
      </div>
      <div className="form-actions">
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
    </Dialog>
  );
}

function Profile({ me, onSaved }: { me: Me; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(me.user.displayName ?? "");
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>();

  async function save(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length > 60) {
      setProblem("Use at most 60 characters.");
      return;
    }
    setProblem(undefined);
    setBusy(true);
    setFailure(undefined);
    try {
      await account.updateProfile(trimmed === "" ? null : trimmed);
      toast(trimmed ? "Display name saved" : "Display name removed");
      onSaved();
    } catch (error) {
      if (error instanceof ApiError && error.code === "BAD_REQUEST") {
        setProblem("Use letters, digits, spaces and punctuation only.");
      } else {
        setFailure(error);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Profile">
      <form className="form" onSubmit={(event) => void save(event)} noValidate>
        <h3>Profile</h3>
        <Field
          label="Display name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          hint="Shown in the navbar instead of your email. Leave empty to use your email."
          error={problem}
          maxLength={60}
          autoComplete="name"
        />
        <Field label="Email" value={me.user.email} readOnly disabled />
        <FormError error={failure} />
        <div className="form-actions">
          <Button variant="primary" type="submit" disabled={busy}>
            {busy ? "Saving..." : "Save profile"}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function ChangePassword() {
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [errors, setErrors] = useState<{ current?: string; next?: string }>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>();

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    const found: typeof errors = {};
    if (!current) found.current = "Enter your current password.";
    if (next.length < MIN_PASSWORD)
      found.next = `Use at least ${MIN_PASSWORD} characters.`;
    else if (next === current)
      found.next = "Choose a password different from the current one.";
    setErrors(found);
    if (found.current || found.next) return;
    setBusy(true);
    setFailure(undefined);
    try {
      await auth.changePassword({
        currentPassword: current,
        newPassword: next,
      });
      setCurrent("");
      setNext("");
      toast("Password changed. Your other sessions were logged out");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setErrors({ current: "That isn't your current password." });
      } else if (error instanceof ApiError && error.code === "BAD_REQUEST") {
        setErrors({ next: error.message });
      } else {
        setFailure(error);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Change password">
      <form
        className="form"
        onSubmit={(event) => void changePassword(event)}
        noValidate
      >
        <h3>Change password</h3>
        <Field
          label="Current password"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          error={errors.current}
        />
        <Field
          label="New password"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          hint={`At least ${MIN_PASSWORD} characters. Your other sessions will be logged out.`}
          error={errors.next}
          maxLength={128}
        />
        <FormError error={failure} />
        <div className="form-actions">
          <Button variant="primary" type="submit" disabled={busy}>
            {busy ? "Changing..." : "Change password"}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function describeBrowser(userAgent: string | null): string {
  if (!userAgent) return "Unknown browser";
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /OPR\//.test(userAgent)
      ? "Opera"
      : /Firefox\//.test(userAgent)
        ? "Firefox"
        : /Chrome\//.test(userAgent)
          ? "Chrome"
          : /Safari\//.test(userAgent)
            ? "Safari"
            : "A browser";
  const os = /Windows/.test(userAgent)
    ? "Windows"
    : /Android/.test(userAgent)
      ? "Android"
      : /iPhone|iPad/.test(userAgent)
        ? "iOS"
        : /Mac OS X/.test(userAgent)
          ? "macOS"
          : /Linux/.test(userAgent)
            ? "Linux"
            : undefined;
  return os ? `${browser} on ${os}` : browser;
}

function Sessions() {
  const router = useRouter();
  const toast = useToast();
  const markSignedIn = useMarkSignedIn();
  const sessions = useLoad(() => account.sessions(), []);
  const [ending, setEnding] = useState<SessionInfo>();
  const [confirmAll, setConfirmAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>();

  function close() {
    setEnding(undefined);
    setConfirmAll(false);
    setFailure(undefined);
    setBusy(false);
  }

  async function endOne(session: SessionInfo) {
    setBusy(true);
    setFailure(undefined);
    try {
      await account.revokeSession(session.id);
      if (session.current) {
        markSignedIn(false);
        router.replace("/login");
        return;
      }
      toast("Session ended");
      close();
      sessions.reload();
    } catch (error) {
      setFailure(error);
      setBusy(false);
    }
  }

  async function endAll() {
    setBusy(true);
    setFailure(undefined);
    try {
      await auth.logoutAll();
      markSignedIn(false);
      router.replace("/login");
    } catch (error) {
      setFailure(error);
      setBusy(false);
    }
  }

  return (
    <Panel title="Sessions">
      <div className="section">
        <div className="row row-between">
          <h3>Signed in sessions</h3>
          <Button variant="danger" onClick={() => setConfirmAll(true)}>
            Log out everywhere
          </Button>
        </div>
        <p className="muted">
          Every browser signed in to your account. Don&apos;t recognise one? End
          it, then change your password.
        </p>
        {sessions.status === "loading" && <Loading />}
        {sessions.status === "error" && (
          <ErrorState error={sessions.error} onRetry={sessions.reload} />
        )}
        {sessions.status === "ready" && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Browser</th>
                  <th scope="col">IP address</th>
                  <th scope="col">Signed in</th>
                  <th scope="col">Last active</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sessions.data.sessions.map((session) => (
                  <tr key={session.id}>
                    <td data-label="Browser">
                      {describeBrowser(session.userAgent)}
                    </td>
                    <td data-label="IP address">
                      <span className="mono">{session.ip ?? "Unknown"}</span>
                    </td>
                    <td data-label="Signed in">
                      {formatDate(session.createdAt)}
                    </td>
                    <td data-label="Last active">
                      {formatDate(session.lastUsedAt)}
                    </td>
                    <td data-label="Actions">
                      <Button
                        variant="ghost"
                        onClick={() => setEnding(session)}
                      >
                        {session.current ? "Log out" : "End session"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <ConfirmDialog
        open={ending !== undefined}
        title={ending?.current ? "Log out" : "End session"}
        confirmLabel={ending?.current ? "Log out" : "End session"}
        busyLabel="Ending..."
        busy={busy}
        error={failure}
        onConfirm={() => ending && void endOne(ending)}
        onCancel={close}
      >
        <p>
          {ending?.current
            ? "This browser is signed out."
            : `${describeBrowser(ending?.userAgent ?? null)} (${ending?.ip ?? "unknown IP"}) is signed out at its next request.`}
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmAll}
        title="Log out everywhere"
        confirmLabel="Log out everywhere"
        busyLabel="Logging out..."
        busy={busy}
        error={failure}
        onConfirm={() => void endAll()}
        onCancel={close}
      >
        <p>
          Every session of your account ends, including this one. You&apos;ll
          need to log in again.
        </p>
      </ConfirmDialog>
    </Panel>
  );
}

function Workspaces({
  workspaces,
  onLeft,
}: {
  workspaces: WorkspaceSummary[];
  onLeft: () => void;
}) {
  const toast = useToast();
  const [leaving, setLeaving] = useState<WorkspaceSummary>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>();

  function close() {
    setLeaving(undefined);
    setFailure(undefined);
    setBusy(false);
  }

  async function leave(workspace: WorkspaceSummary) {
    setBusy(true);
    setFailure(undefined);
    try {
      await account.leaveWorkspace(workspace.id);
      toast(`You left ${workspace.name}`);
      close();
      onLeft();
    } catch (error) {
      setFailure(error);
      setBusy(false);
    }
  }

  return (
    <Panel title="Your workspaces">
      <div className="section">
        <div className="row row-between">
          <h3>Your workspaces</h3>
          <Link className="button" data-variant="secondary" href="/workspaces">
            New workspace
          </Link>
        </div>
        {workspaces.length === 0 ? (
          <p className="muted">You aren&apos;t in any workspace.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Workspace</th>
                  <th scope="col">Your role</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {workspaces.map((workspace) => (
                  <tr key={workspace.id}>
                    <td data-label="Workspace">
                      <Link href={`/workspaces/${workspace.id}`}>
                        {workspace.name}
                      </Link>
                    </td>
                    <td data-label="Your role">
                      {workspace.role === "owner" ? (
                        <Status tone="info">Owner</Status>
                      ) : (
                        <Status>Member</Status>
                      )}
                    </td>
                    <td data-label="Actions">
                      <Button
                        variant="ghost"
                        onClick={() => setLeaving(workspace)}
                      >
                        Leave
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted">
          You can&apos;t leave a workspace you are the only owner of: delete it
          from its Settings page instead.
        </p>
      </div>
      <ConfirmDialog
        open={leaving !== undefined}
        title="Leave workspace"
        confirmLabel="Leave workspace"
        busyLabel="Leaving..."
        busy={busy}
        error={failure}
        onConfirm={() => leaving && void leave(leaving)}
        onCancel={close}
      >
        <p>
          You lose access to <strong>{leaving?.name}</strong>. An owner can add
          you back.
        </p>
      </ConfirmDialog>
    </Panel>
  );
}

function DeleteAccount({ me }: { me: Me }) {
  const router = useRouter();
  const markSignedIn = useMarkSignedIn();
  const hasPassword = me.user.hasPassword;
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>();

  function close() {
    setOpen(false);
    setPassword("");
    setProblem(undefined);
    setFailure(undefined);
    setBusy(false);
  }

  async function remove() {
    if (!password) {
      setProblem(
        hasPassword
          ? "Enter your password to confirm."
          : "Type your email address to confirm.",
      );
      return;
    }
    setBusy(true);
    setProblem(undefined);
    setFailure(undefined);
    try {
      await account.deleteAccount(
        hasPassword ? { password } : { email: password },
      );
      markSignedIn(false);
      router.replace("/login");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setProblem("That isn't your password.");
      } else if (error instanceof ApiError && error.status === 400) {
        setProblem("That isn't your email address.");
      } else if (error instanceof ApiError && error.code === "CONFLICT") {
        setProblem(error.message);
      } else {
        setFailure(error);
      }
      setBusy(false);
    }
  }

  return (
    <Panel title="Delete account">
      <div className="section">
        <h3>Delete account</h3>
        <p className="muted">
          Your account, memberships and sessions are deleted. The workspaces
          stay with their other members. Not possible while you are the only
          owner of a workspace.
        </p>
        <div>
          <Button variant="danger" onClick={() => setOpen(true)}>
            Delete account
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={open}
        title="Delete account"
        confirmLabel="Delete account"
        busyLabel="Deleting..."
        busy={busy}
        error={failure}
        onConfirm={() => void remove()}
        onCancel={close}
      >
        <p>
          This can&apos;t be undone.{" "}
          {hasPassword
            ? "Enter your password to confirm."
            : `Type ${me.user.email} to confirm.`}
        </p>
        <Field
          label={hasPassword ? "Password" : "Email"}
          type={hasPassword ? "password" : "email"}
          autoComplete={hasPassword ? "current-password" : "off"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={problem}
        />
      </ConfirmDialog>
    </Panel>
  );
}

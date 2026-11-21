"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { AppNavbar } from "@/components/app-navbar";
import { Icon } from "@/components/icons";
import {
  Button,
  Dialog,
  ErrorState,
  Field,
  FormError,
  Loading,
  PageHeader,
} from "@/components/ui";
import { ApiError } from "@/lib/api/client";
import { account, auth } from "@/lib/api/endpoints";
import { useToast } from "@/lib/toast";
import { loginUrl } from "@/lib/safe-redirect";
import { useMarkSignedIn } from "@/lib/session";
import { useLoad } from "@/lib/use-load";

export default function WorkspacePicker() {
  const router = useRouter();
  const markSignedIn = useMarkSignedIn();
  const toast = useToast();
  const [newName, setNewName] = useState("");
  const [nameError, setNameError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const me = useLoad(async () => {
    const data = await auth.me();
    markSignedIn(true);
    return data;
  }, []);

  const loggedOut =
    me.status === "error" &&
    me.error instanceof ApiError &&
    me.error.status === 401;
  useEffect(() => {
    if (loggedOut) router.replace(loginUrl("/workspaces"));
  }, [loggedOut, router]);

  if (me.status === "loading" || loggedOut) {
    return (
      <main className="auth-page">
        <Loading />
      </main>
    );
  }
  if (me.status === "error") {
    return (
      <main className="auth-page">
        <div className="auth-card">
          <ErrorState error={me.error} onRetry={me.reload} />
        </div>
      </main>
    );
  }

  const { workspaces } = me.data;

  function close() {
    setOpen(false);
    setNameError(undefined);
    setFailure(undefined);
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    const name = newName.trim();
    if (!name) {
      setNameError("Enter a name for the workspace.");
      return;
    }
    setNameError(undefined);
    setFailure(undefined);
    setCreating(true);
    try {
      const created = await account.createWorkspace(name);
      toast(`Workspace ${created.name} created`);
      router.push(`/workspaces/${created.id}`);
    } catch (error) {
      if (error instanceof ApiError && error.code === "CONFLICT") {
        setNameError(error.message);
      } else {
        setFailure(error);
      }
      setCreating(false);
    }
  }

  return (
    <div className="picker">
      <AppNavbar me={me.data} onMeChanged={me.reload} />
      <main className="page picker-page">
        <PageHeader
          label="Choose a workspace"
          title="Your workspaces"
          description={
            workspaces.length === 0
              ? "You aren't in any workspace right now."
              : `You belong to ${workspaces.length} ${
                  workspaces.length === 1 ? "workspace" : "workspaces"
                }. Choose the one you want to work in.`
          }
          actions={
            <Button variant="primary" onClick={() => setOpen(true)}>
              <Icon name="plus" />
              Create workspace
            </Button>
          }
        />
        {workspaces.length === 0 ? (
          <div className="card stack-2">
            <h2>No workspaces</h2>
            <p className="muted">
              Ask a workspace owner to add you, or create a workspace of your
              own.
            </p>
          </div>
        ) : (
          <ul className="picker-grid" aria-label="Your workspaces">
            {workspaces.map((ws) => (
              <li key={ws.id}>
                <Link className="picker-card" href={`/workspaces/${ws.id}`}>
                  <span className="picker-initial" aria-hidden="true">
                    {ws.name.trim().charAt(0).toUpperCase() || "?"}
                  </span>
                  <span className="picker-text">
                    <span className="picker-name">{ws.name}</span>
                    <span className="pill">
                      {ws.role === "owner" ? "Owner" : "Member"}
                    </span>
                  </span>
                  <span className="picker-open" aria-hidden="true">
                    Open →
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
      <Dialog open={open} title="Create workspace" onClose={close}>
        <form
          className="form"
          onSubmit={(event) => void create(event)}
          noValidate
        >
          <p className="muted">
            A separate space with its own API keys, secrets, files and audit
            log. You&apos;ll be its owner.
          </p>
          <Field
            label="Workspace name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            error={nameError}
            hint="For example Production apps, or your team's name."
            maxLength={100}
            autoFocus
          />
          <FormError error={failure} />
          <div className="form-actions">
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={creating}>
              {creating ? "Creating..." : "Create workspace"}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}

"use client";

import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { AppNavbar } from "@/components/app-navbar";
import { DeleteWorkspaceDialog } from "@/components/delete-workspace";
import { Icon } from "@/components/icons";
import { SidebarNav } from "@/components/sidebar-nav";
import { NotFound } from "@/components/not-found";
import { Banner, Button, ErrorState, Loading } from "@/components/ui";
import { ApiError } from "@/lib/api/client";
import { auth, workspace as api } from "@/lib/api/endpoints";
import { WORKSPACE_NAV } from "@/lib/nav";
import { loginUrl } from "@/lib/safe-redirect";
import { useMarkSignedIn } from "@/lib/session";
import { useLoad } from "@/lib/use-load";
import { WorkspaceContext } from "@/lib/workspace";

export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const pathname = usePathname();
  const router = useRouter();
  const markSignedIn = useMarkSignedIn();
  const [menuOpen, setMenuOpen] = useState(false);

  const state = useLoad(async () => {
    const me = await auth.me();
    markSignedIn(true);
    try {
      const overview = await api.overview(workspaceId);
      return { me, overview };
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        return { me, overview: null };
      }
      throw error;
    }
  }, [workspaceId]);

  useEffect(() => setMenuOpen(false), [pathname]);
  const loggedOut =
    state.status === "error" &&
    state.error instanceof ApiError &&
    state.error.status === 401;
  useEffect(() => {
    if (loggedOut) router.replace(loginUrl(pathname));
  }, [loggedOut, pathname, router]);

  if (state.status === "loading" || loggedOut) {
    return (
      <main className="auth-page">
        <Loading />
      </main>
    );
  }
  if (state.status === "error") {
    if (state.error instanceof ApiError && state.error.status === 404)
      return <NotFound />;
    return (
      <main className="auth-page">
        <div className="auth-card">
          <ErrorState error={state.error} onRetry={state.reload} />
        </div>
      </main>
    );
  }

  const { me, overview } = state.data;
  if (!overview) {
    const membership = me.workspaces.find((w) => w.id === workspaceId);
    return (
      <BeingDeleted
        id={workspaceId}
        name={membership?.name ?? ""}
        isOwner={membership?.role === "owner"}
      />
    );
  }
  const base = `/workspaces/${workspaceId}`;
  const sealed = overview.secretsSealed === true;

  return (
    <WorkspaceContext.Provider
      value={{
        id: workspaceId,
        me,
        overview,
        isOwner: overview.role === "owner",
        sealed,
        refresh: state.reload,
      }}
    >
      <div className="shell">
        <AppNavbar
          me={me}
          workspaceId={workspaceId}
          menuOpen={menuOpen}
          onToggleMenu={() => setMenuOpen((open) => !open)}
          onMeChanged={state.reload}
        />
        <div className="shell-body">
          <aside className="sidebar" id="sidebar" data-open={menuOpen}>
            <Link className="sidebar-back body-5" href="/workspaces">
              <Icon name="arrow-left" size={16} />
              Back to workspaces
            </Link>
            <SidebarNav
              groups={WORKSPACE_NAV}
              base={base}
              pathname={pathname}
            />
          </aside>
          <main className="main">
            <div className="page">
              {sealed && (
                <Banner title="Secrets are sealed" tone="destructive">
                  The secrets service is sealed until an operator unseals it.
                  Until then you can&apos;t create or rotate secrets, upload or
                  download files, or use proxy connections. Lists, metadata and
                  the audit log still work.
                </Banner>
              )}
              {children}
            </div>
          </main>
        </div>
      </div>
    </WorkspaceContext.Provider>
  );
}

function BeingDeleted({
  id,
  name,
  isOwner,
}: {
  id: string;
  name: string;
  isOwner: boolean;
}) {
  const [finishing, setFinishing] = useState(false);
  return (
    <main className="auth-page">
      <div className="auth-card stack-2">
        <Banner title="Workspace being deleted" tone="destructive">
          The deletion of {name} started but didn&apos;t finish. Its encryption
          key may already be destroyed, so nothing in it can be used.{" "}
          {isOwner
            ? "Finish the deletion to remove what's left."
            : "An owner can finish the deletion."}
        </Banner>
        <div className="row">
          {isOwner && (
            <Button variant="danger" onClick={() => setFinishing(true)}>
              Finish deletion
            </Button>
          )}
          <Link className="button" data-variant="ghost" href="/workspaces">
            Your workspaces
          </Link>
        </div>
      </div>
      {finishing && (
        <DeleteWorkspaceDialog
          id={id}
          name={name}
          finishing
          onClose={() => setFinishing(false)}
        />
      )}
    </main>
  );
}

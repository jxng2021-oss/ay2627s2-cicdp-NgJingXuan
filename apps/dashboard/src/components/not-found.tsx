import Link from "next/link";

export function NotFound() {
  return (
    <main className="auth-page">
      <div className="auth-card">
        <p className="wordmark">secure-cloud</p>
        <div className="section">
          <p className="sec-label">404</p>
          <h1>Page not found</h1>
          <p className="muted">
            This page doesn&apos;t exist, or you don&apos;t have access to it.
            Check the address, or go back to your workspaces.
          </p>
        </div>
        <div>
          <Link className="button" data-variant="secondary" href="/workspaces">
            Go to workspaces
          </Link>
        </div>
      </div>
    </main>
  );
}

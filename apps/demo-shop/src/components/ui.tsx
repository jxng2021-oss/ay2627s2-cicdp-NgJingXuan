import type { ReactNode } from "react";
import type { ErrorView } from "@/lib/messages";

export function PageHeader({
  label,
  title,
  description,
  children,
}: {
  label?: string;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-title">
        {label && <p className="sec-label">{label}</p>}
        <h1>{title}</h1>
        {description && <p className="muted">{description}</p>}
      </div>
      {children}
    </header>
  );
}

export function ErrorBanner({ error }: { error: ErrorView }) {
  return (
    <div className="banner" data-tone="destructive" role="alert">
      <div className="stack-2">
        <p className="banner-title">{error.title}</p>
        <p className="muted">{error.message}</p>
        {error.requestId && (
          <p className="muted">
            Request ID <code>{error.requestId}</code>
          </p>
        )}
      </div>
    </div>
  );
}

export function Status({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <span className="chip" data-tone={ok ? "strong" : "destructive"}>
      <span className="dot" aria-hidden="true" />
      {children}
    </span>
  );
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-SG", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Singapore",
  });
}

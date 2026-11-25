"use client";

import Link from "next/link";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { ApiError } from "@/lib/api/client";
import { Icon } from "./icons";

type Variant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  variant = "secondary",
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button {...props} type={type} className="button" data-variant={variant} />
  );
}

export function InfoTip({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <span className="info-tip" data-open={open || undefined}>
      <button
        type="button"
        className="info-tip-button"
        aria-label={label}
        aria-describedby={id}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
      >
        <Icon name="info" size={16} />
      </button>
      <span role="tooltip" id={id} className="info-tip-text">
        {children}
      </span>
    </span>
  );
}

export function Field({
  label,
  hint,
  error,
  info,
  ...input
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
  error?: string;
  info?: ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className="field">
      {info ? (
        <span className="field-label">
          <label htmlFor={id}>{label}</label>
          {info}
        </span>
      ) : (
        <label htmlFor={id}>{label}</label>
      )}
      <input
        {...input}
        id={id}
        className="input"
        aria-invalid={error ? true : undefined}
        aria-describedby={
          [hintId, errorId].filter(Boolean).join(" ") || undefined
        }
      />
      {hint && (
        <p className="hint" id={hintId}>
          {hint}
        </p>
      )}
      {error && (
        <p className="field-error" id={errorId}>
          {error}
        </p>
      )}
    </div>
  );
}

export function Card({
  children,
  title,
}: {
  children: ReactNode;
  title?: string;
}) {
  return (
    <section className="card" aria-label={title}>
      {children}
    </section>
  );
}

export type StatusTone = "neutral" | "success" | "warning" | "danger" | "info";

export function Status({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: StatusTone;
}) {
  return (
    <span className="chip" data-tone={tone}>
      <span className="dot" aria-hidden="true" />
      {children}
    </span>
  );
}

export function Banner({
  title,
  children,
  tone = "default",
}: {
  title: string;
  children?: ReactNode;
  tone?: "default" | "destructive";
}) {
  return (
    <div
      className="banner"
      data-tone={tone}
      role={tone === "destructive" ? "alert" : "status"}
    >
      <div>
        <p className="banner-title">{title}</p>
        {children && <div className="muted">{children}</div>}
      </div>
    </div>
  );
}

export function PageHeader({
  label,
  title,
  description,
  actions,
}: {
  label: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-title">
        <p className="sec-label">{label}</p>
        <h1>{title}</h1>
        {description && <p className="muted">{description}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </header>
  );
}

export function Loading({ label = "Loading..." }: { label?: string }) {
  return (
    <p className="muted" role="status" aria-live="polite">
      {label}
    </p>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="card">
      <p className="muted">{children}</p>
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}) {
  const known = error instanceof ApiError;
  const message = known
    ? error.message
    : "Something went wrong. Reload the page, then retry.";
  const unexpected = !known || error.status >= 500 || error.status === 0;
  return (
    <div className="banner" data-tone="destructive" role="alert">
      <div className="stack-2">
        <p className="banner-title">
          {unexpected ? "Something went wrong" : message}
        </p>
        {unexpected && <p className="muted">{message}</p>}
        {unexpected && known && error.requestId && (
          <p className="muted">
            Request ID <code>{error.requestId}</code>
          </p>
        )}
        {onRetry && (
          <div>
            <Button onClick={onRetry}>Retry request</Button>
          </div>
        )}
      </div>
    </div>
  );
}

export function FormError({ error }: { error: unknown }) {
  if (!error) return null;
  return <ErrorState error={error} />;
}

export function Dialog({
  open,
  title,
  onClose,
  children,
  size = "md",
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  size?: "md" | "lg";
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="dialog"
      data-size={size}
      aria-labelledby={titleId}
      onClose={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {open && (
        <div className="dialog-body">
          <h2 id={titleId}>{title}</h2>
          {children}
        </div>
      )}
    </dialog>
  );
}

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  busyLabel,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busyLabel: string;
  busy: boolean;
  error?: unknown;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={open} title={title} onClose={onCancel}>
      <div className="muted">{children}</div>
      <FormError error={error} />
      <div className="form-actions">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Keep it
        </Button>
        <Button variant="danger" onClick={onConfirm} disabled={busy} autoFocus>
          {busy ? busyLabel : confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function Pager({
  next,
  onNext,
  onFirst,
}: {
  next: string | null;
  onNext: (cursor: string) => void;
  onFirst?: () => void;
}) {
  if (!next && !onFirst) return null;
  return (
    <nav className="row" aria-label="Pages">
      {onFirst && (
        <Button variant="ghost" onClick={onFirst}>
          First page
        </Button>
      )}
      {next && <Button onClick={() => onNext(next)}>Next page</Button>}
    </nav>
  );
}

export function ArrowLink({ href, label }: { href: string; label: string }) {
  return (
    <Link className="icon-button" href={href} aria-label={label} title={label}>
      <Icon name="arrow-right" size={18} />
    </Link>
  );
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={copied ? `${label}: copied` : label}
      title={copied ? "Copied" : label}
      onClick={() =>
        void navigator.clipboard.writeText(value).then(() => setCopied(true))
      }
    >
      <Icon name={copied ? "check" : "copy"} size={16} />
    </button>
  );
}

export function shorten(value: string, head = 12, tail = 6): string {
  return value.length <= head + tail + 1
    ? value
    : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function ShortValue({ value, label }: { value: string; label: string }) {
  return (
    <span className="short-value">
      <code title={value}>{shorten(value)}</code>
      <CopyButton value={value} label={`Copy ${label}`} />
    </span>
  );
}

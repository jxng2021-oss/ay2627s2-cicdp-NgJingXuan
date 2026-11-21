"use client";

import { Fragment, useState, type FormEvent } from "react";
import { Icon } from "@/components/icons";
import {
  Button,
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
  ShortValue,
  Status,
  formatDate,
} from "@/components/ui";
import type { AuditEvent } from "@/lib/api/client";
import { workspace as api } from "@/lib/api/endpoints";
import { useLoad } from "@/lib/use-load";
import { useWorkspace } from "@/lib/workspace";

const ACTIONS = [
  "user.signed_up",
  "user.logged_in",
  "user.login_failed",
  "user.logged_out",
  "user.password_changed",
  "membership.added",
  "membership.removed",
  "user.profile_updated",
  "user.session_revoked",
  "user.deleted",
  "api_key.created",
  "api_key.revoked",
  "secret.created",
  "secret.read",
  "secret.rotated",
  "secret.revealed",
  "secret.deleted",
  "file.uploaded",
  "file.downloaded",
  "file.deleted",
  "proxy_connection.created",
  "proxy_connection.updated",
  "proxy_connection.deleted",
  "proxy_connection.used",
  "proxy_connection.denied",
  "tenant.created",
  "tenant.suspended",
  "user_pool.created",
  "user_pool.updated",
  "user_pool.deleted",
  "pool_user.signed_up",
  "pool_user.updated",
  "pool_user.deleted",
  "pool_user.password_reset",
  "pool_user.password_changed",
  "pool_user.logged_in",
  "pool_user.login_failed",
  "pool_user.logged_out",
  "pool_user.token_reused",
  "pool_role.created",
  "pool_role.updated",
  "pool_role.deleted",
  "pool_user.role_added",
  "pool_user.role_removed",
  "feature_flag.created",
  "feature_flag.updated",
  "feature_flag.toggled",
  "feature_flag.deleted",
] as const satisfies readonly AuditEvent["action"][];
const OUTCOMES = [
  "success",
  "denied",
  "failure",
] as const satisfies readonly AuditEvent["outcome"][];
const RESOURCES = [
  "user",
  "membership",
  "api_key",
  "secret",
  "file",
  "proxy_connection",
  "tenant",
  "user_pool",
  "pool_user",
  "pool_role",
  "feature_flag",
] as const satisfies readonly AuditEvent["resourceType"][];
const PAGE_SIZE = 15;

interface Filters {
  action: string;
  outcome: string;
  resourceType: string;
  from: string;
  to: string;
}
const NO_FILTERS: Filters = {
  action: "",
  outcome: "",
  resourceType: "",
  from: "",
  to: "",
};

function iso(local: string): string | undefined {
  if (!local) return undefined;
  const date = new Date(local);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export default function AuditPage() {
  const { id } = useWorkspace();
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [cursors, setCursors] = useState<string[]>([]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (eventId: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(eventId)) next.add(eventId);
      return next;
    });
  const cursor = cursors.at(-1);
  const events = useLoad(
    () =>
      api.auditEvents(id, {
        limit: PAGE_SIZE,
        cursor,
        action: filters.action || undefined,
        outcome: filters.outcome || undefined,
        resourceType: filters.resourceType || undefined,
        from: iso(filters.from),
        to: iso(filters.to),
      }),
    [id, cursor, filters],
  );

  function apply(event: FormEvent) {
    event.preventDefault();
    setCursors([]);
    setFilters(draft);
  }

  function clear() {
    setDraft(NO_FILTERS);
    setFilters(NO_FILTERS);
    setCursors([]);
  }

  const choose = (
    key: "action" | "outcome" | "resourceType",
    label: string,
    options: readonly string[],
  ) => (
    <div className="field">
      <label htmlFor={`audit-${key}`}>{label}</label>
      <select
        id={`audit-${key}`}
        className="select"
        value={draft[key]}
        onChange={(event) =>
          setDraft((current) => ({ ...current, [key]: event.target.value }))
        }
      >
        <option value="">Any</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <>
      <PageHeader
        label="Workspace"
        title="Audit log"
        description="Every sensitive action in this workspace, in a log that shows any edit. Never values, keys or file contents."
      />
      <form
        className="card form"
        onSubmit={(event) => void apply(event)}
        aria-label="Filter audit events"
      >
        <div className="stats">
          {choose("action", "Action", ACTIONS)}
          {choose("outcome", "Outcome", OUTCOMES)}
          {choose("resourceType", "Resource", RESOURCES)}
          <div className="field">
            <label htmlFor="audit-from">From</label>
            <input
              id="audit-from"
              className="input"
              type="datetime-local"
              value={draft.from}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  from: event.target.value,
                }))
              }
            />
          </div>
          <div className="field">
            <label htmlFor="audit-to">To</label>
            <input
              id="audit-to"
              className="input"
              type="datetime-local"
              value={draft.to}
              onChange={(event) =>
                setDraft((current) => ({ ...current, to: event.target.value }))
              }
            />
          </div>
        </div>
        <div className="form-actions">
          <Button variant="ghost" onClick={clear}>
            Clear filters
          </Button>
          <Button type="submit">Apply filters</Button>
        </div>
      </form>

      {events.status === "loading" && <Loading />}
      {events.status === "error" && (
        <ErrorState error={events.error} onRetry={events.reload} />
      )}
      {events.status === "ready" &&
        (events.data.events.length === 0 ? (
          <EmptyState>
            No events match these filters. Clear them to see everything.
          </EmptyState>
        ) : (
          <div className="section">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">Action</th>
                    <th scope="col">Outcome</th>
                    <th scope="col">Actor</th>
                    <th scope="col">Resource</th>
                    <th scope="col">
                      <span className="sr-only">Details</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {events.data.events.map((event) => (
                    <Fragment key={event.id}>
                      <tr>
                        <td data-label="Time">
                          {formatDate(event.occurredAt)}
                        </td>
                        <td data-label="Action">
                          <code>{event.action}</code>
                        </td>
                        <td data-label="Outcome">
                          <Status
                            tone={
                              event.outcome === "success"
                                ? "success"
                                : event.outcome === "failure"
                                  ? "danger"
                                  : "warning"
                            }
                          >
                            {event.outcome}
                          </Status>
                        </td>
                        <td data-label="Actor" className="mono">
                          <span>
                            {event.actorType}
                            {event.actorId && (
                              <span className="muted">
                                {" "}
                                {event.actorId.slice(0, 8)}
                              </span>
                            )}
                          </span>
                        </td>
                        <td data-label="Resource" className="mono">
                          <span>
                            {event.resourceType}
                            {event.resourceId && (
                              <span className="muted"> {event.resourceId}</span>
                            )}
                          </span>
                        </td>
                        <td className="actions">
                          <button
                            type="button"
                            className="icon-button"
                            aria-expanded={open.has(event.id)}
                            aria-controls={`event-${event.id}`}
                            aria-label={`Details of ${event.action}`}
                            onClick={() => toggle(event.id)}
                          >
                            <Icon name="arrow-right" size={18} />
                          </button>
                        </td>
                      </tr>
                      {open.has(event.id) && (
                        <tr className="event-details" id={`event-${event.id}`}>
                          <td colSpan={6}>
                            <dl className="details-grid">
                              <dt>Source IP</dt>
                              <dd className="mono">{event.sourceIp ?? "—"}</dd>
                              <dt>Request ID</dt>
                              <dd>
                                {event.requestId ? (
                                  <ShortValue
                                    value={event.requestId}
                                    label="request ID"
                                  />
                                ) : (
                                  "—"
                                )}
                              </dd>
                              <dt>Actor ID</dt>
                              <dd className="mono">{event.actorId ?? "—"}</dd>
                              <dt>Resource ID</dt>
                              <dd className="mono">
                                {event.resourceId ?? "—"}
                              </dd>
                            </dl>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            <nav className="row" aria-label="Audit log pages">
              <Button
                variant="ghost"
                disabled={cursors.length === 0}
                onClick={() => setCursors((current) => current.slice(0, -1))}
              >
                Previous page
              </Button>
              <Button
                disabled={!events.data.nextCursor}
                onClick={() => {
                  const next = events.data.nextCursor;
                  if (next) setCursors((current) => [...current, next]);
                }}
              >
                Next page
              </Button>
            </nav>
          </div>
        ))}
    </>
  );
}

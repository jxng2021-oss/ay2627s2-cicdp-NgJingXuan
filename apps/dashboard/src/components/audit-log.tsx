"use client";

import { Fragment, useState, type FormEvent } from "react";
import { Icon } from "@/components/icons";
import {
  Button,
  EmptyState,
  ErrorState,
  Loading,
  ShortValue,
  Status,
  formatDate,
} from "@/components/ui";
import { useLoad } from "@/lib/use-load";

export interface LogEvent {
  id: string;
  occurredAt: string;
  actorType: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  outcome: "success" | "denied" | "failure";
  requestId: string | null;
  sourceIp: string | null;
}

export interface LogPage {
  events: LogEvent[];
  nextCursor: string | null;
}

export type LogQuery = Record<string, string | number | undefined>;

const OUTCOMES = ["success", "denied", "failure"] as const;
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

export function AuditLog({
  id,
  label,
  actions,
  resources,
  load,
  dependsOn,
}: {
  id: string;
  label: string;
  actions: readonly string[];
  resources: readonly string[];
  load: (query: LogQuery) => Promise<LogPage>;
  dependsOn: unknown[];
}) {
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
      load({
        limit: PAGE_SIZE,
        cursor,
        action: filters.action || undefined,
        outcome: filters.outcome || undefined,
        resourceType: filters.resourceType || undefined,
        from: iso(filters.from),
        to: iso(filters.to),
      }),
    [...dependsOn, cursor, filters],
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
    title: string,
    options: readonly string[],
  ) => (
    <div className="field">
      <label htmlFor={`${id}-${key}`}>{title}</label>
      <select
        id={`${id}-${key}`}
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
      <form
        className="card form"
        onSubmit={(event) => void apply(event)}
        aria-label={`Filter ${label}`}
      >
        <div className="stats">
          {choose("action", "Action", actions)}
          {choose("outcome", "Outcome", OUTCOMES)}
          {choose("resourceType", "Resource", resources)}
          <div className="field">
            <label htmlFor={`${id}-from`}>From</label>
            <input
              id={`${id}-from`}
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
            <label htmlFor={`${id}-to`}>To</label>
            <input
              id={`${id}-to`}
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
            <nav className="row" aria-label={`${label} pages`}>
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

"use client";

import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";
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

export type LogQuery = Record<string, string | number | string[] | undefined>;

const OUTCOMES = ["success", "denied", "failure"] as const;
const PAGE_SIZE = 15;

interface Filters {
  action: string[];
  outcome: string[];
  resourceType: string[];
  from: string;
  to: string;
}
const NO_FILTERS: Filters = {
  action: [],
  outcome: [],
  resourceType: [],
  from: "",
  to: "",
};

function MultiSelect({
  label,
  options,
  chosen,
  onChange,
}: {
  label: string;
  options: readonly string[];
  chosen: string[];
  onChange: (chosen: string[]) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (
        event instanceof KeyboardEvent
          ? event.key === "Escape"
          : !box.current?.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  const summary =
    chosen.length === 0
      ? "Any"
      : chosen.length === 1
        ? chosen[0]
        : `${chosen.length} chosen`;
  const toggle = (option: string) =>
    onChange(
      chosen.includes(option)
        ? chosen.filter((value) => value !== option)
        : [...chosen, option],
    );

  return (
    <div className="field multi-select" ref={box}>
      <span className="multi-select-label" id={`${id}-label`}>
        {label}
      </span>
      <button
        type="button"
        className="select multi-select-button"
        aria-labelledby={`${id}-label ${id}-summary`}
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        onClick={() => setOpen((value) => !value)}
      >
        <span id={`${id}-summary`}>{summary}</span>
        <Icon name="chevron-down" size={16} />
      </button>
      <div
        id={`${id}-panel`}
        className="multi-select-panel"
        role="group"
        aria-labelledby={`${id}-label`}
        hidden={!open}
      >
        {options.map((option) => (
          <label key={option} className="checkbox-field">
            <input
              type="checkbox"
              checked={chosen.includes(option)}
              onChange={() => toggle(option)}
            />
            <span className="mono">{option}</span>
          </label>
        ))}
        {chosen.length > 0 && (
          <Button variant="ghost" onClick={() => onChange([])}>
            Clear {label.toLowerCase()}
          </Button>
        )}
      </div>
    </div>
  );
}

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
        action: filters.action,
        outcome: filters.outcome,
        resourceType: filters.resourceType,
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
    <MultiSelect
      label={title}
      options={options}
      chosen={draft[key]}
      onChange={(chosen) =>
        setDraft((current) => ({ ...current, [key]: chosen }))
      }
    />
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

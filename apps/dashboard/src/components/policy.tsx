"use client";

import { useId } from "react";
import type { ConnectionPolicy } from "@/lib/api/client";
import { Field } from "./ui";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
type Method = (typeof METHODS)[number];
const PATH = /^(\/([A-Za-z0-9._~-]+|\*))+$|^\/$/;
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export interface PolicyForm {
  routes: string;
  requests: string;
  windowSeconds: string;
  field: string;
  maxPerRequest: string;
  maxPerDay: string;
}

export const EMPTY_POLICY: PolicyForm = {
  routes: "",
  requests: "",
  windowSeconds: "60",
  field: "amount",
  maxPerRequest: "",
  maxPerDay: "",
};

export function policyToForm(policy: ConnectionPolicy | null): PolicyForm {
  if (!policy) return EMPTY_POLICY;
  return {
    routes: (policy.allowedRoutes ?? [])
      .map((route) => `${route.method} ${route.path}`)
      .join("\n"),
    requests: policy.rateLimit ? String(policy.rateLimit.requests) : "",
    windowSeconds: policy.rateLimit
      ? String(policy.rateLimit.windowSeconds)
      : "60",
    field: policy.amountLimit?.field ?? "amount",
    maxPerRequest: policy.amountLimit
      ? String(policy.amountLimit.maxPerRequest)
      : "",
    maxPerDay: policy.amountLimit ? String(policy.amountLimit.maxPerDay) : "",
  };
}

const wholeNumber = (text: string, max: number) =>
  /^[0-9]{1,13}$/.test(text) && Number(text) >= 1 && Number(text) <= max;

export function formToPolicy(
  form: PolicyForm,
):
  | { policy: ConnectionPolicy | undefined }
  | { errors: Partial<Record<keyof PolicyForm, string>> } {
  const errors: Partial<Record<keyof PolicyForm, string>> = {};
  const policy: ConnectionPolicy = {};

  const lines = form.routes
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > 0) {
    const routes: { method: Method; path: string }[] = [];
    for (const line of lines) {
      const [method = "", path = "", extra] = line.split(/\s+/);
      if (
        extra !== undefined ||
        !METHODS.includes(method.toUpperCase() as Method) ||
        !PATH.test(path)
      ) {
        errors.routes = `Write one route per line, like "POST /charges" or "GET /charges/*". Check: ${line}`;
        break;
      }
      routes.push({ method: method.toUpperCase() as Method, path });
    }
    if (lines.length > 20) errors.routes = "List at most 20 routes.";
    policy.allowedRoutes = routes;
  }

  if (form.requests.trim() !== "") {
    if (!wholeNumber(form.requests, 10_000))
      errors.requests = "Enter a whole number from 1 to 10,000.";
    if (!wholeNumber(form.windowSeconds, 86_400))
      errors.windowSeconds = "Enter seconds from 1 to 86,400.";
    policy.rateLimit = {
      requests: Number(form.requests),
      windowSeconds: Number(form.windowSeconds),
    };
  }

  if (form.maxPerRequest.trim() !== "" || form.maxPerDay.trim() !== "") {
    if (!FIELD.test(form.field))
      errors.field = "Enter a JSON field name, like amount.";
    if (!wholeNumber(form.maxPerRequest, 1e12))
      errors.maxPerRequest = "Enter a whole number, in the smallest unit.";
    if (!wholeNumber(form.maxPerDay, 1e12))
      errors.maxPerDay = "Enter a whole number, in the smallest unit.";
    else if (Number(form.maxPerDay) < Number(form.maxPerRequest))
      errors.maxPerDay =
        "The daily limit can't be less than the limit per call.";
    policy.amountLimit = {
      field: form.field,
      maxPerRequest: Number(form.maxPerRequest),
      maxPerDay: Number(form.maxPerDay),
    };
  }

  if (Object.keys(errors).length > 0) return { errors };
  return { policy: Object.keys(policy).length > 0 ? policy : undefined };
}

export function describePolicy(policy: ConnectionPolicy | null): string[] {
  if (!policy) return ["No limits"];
  const parts: string[] = [];
  if (policy.allowedRoutes) {
    parts.push(
      `Only ${policy.allowedRoutes
        .map((route) => `${route.method} ${route.path}`)
        .join(", ")}`,
    );
  }
  if (policy.rateLimit) {
    parts.push(
      `${policy.rateLimit.requests} calls per ${policy.rateLimit.windowSeconds}s`,
    );
  }
  if (policy.amountLimit) {
    const n = (value: number) => value.toLocaleString("en");
    parts.push(
      `${policy.amountLimit.field} ≤ ${n(policy.amountLimit.maxPerRequest)} per call, ${n(policy.amountLimit.maxPerDay)} per day`,
    );
  }
  return parts;
}

export function PolicyFields({
  form,
  errors,
  onChange,
}: {
  form: PolicyForm;
  errors: Partial<Record<keyof PolicyForm, string>>;
  onChange: (form: PolicyForm) => void;
}) {
  const routesId = useId();
  const set =
    (key: keyof PolicyForm) => (event: { target: { value: string } }) =>
      onChange({ ...form, [key]: event.target.value });
  return (
    <fieldset className="stack-2 policy-fields">
      <legend className="sec-label">Policy (optional)</legend>
      <p className="muted">
        Limits checked before the secret is even read. Leave a part empty for no
        limit.
      </p>
      <div className="field">
        <label htmlFor={routesId}>Allowed routes</label>
        <textarea
          id={routesId}
          className="textarea mono"
          rows={3}
          value={form.routes}
          onChange={set("routes")}
          placeholder={"POST /charges\nGET /charges/*"}
          aria-invalid={errors.routes ? true : undefined}
          aria-describedby={`${routesId}-hint${errors.routes ? ` ${routesId}-error` : ""}`}
        />
        <p className="hint" id={`${routesId}-hint`}>
          One per line: a method and a path below the base URL. * matches one
          path segment.
        </p>
        {errors.routes && (
          <p className="field-error" id={`${routesId}-error`}>
            {errors.routes}
          </p>
        )}
      </div>
      <div className="policy-row">
        <Field
          label="Calls per window"
          inputMode="numeric"
          value={form.requests}
          onChange={set("requests")}
          error={errors.requests}
        />
        <Field
          label="Window (seconds)"
          inputMode="numeric"
          value={form.windowSeconds}
          onChange={set("windowSeconds")}
          error={errors.windowSeconds}
        />
      </div>
      <Field
        label="Amount field"
        value={form.field}
        onChange={set("field")}
        error={errors.field}
        hint="A whole number in the JSON body of POST, PUT and PATCH calls, like amount in cents."
      />
      <div className="policy-row">
        <Field
          label="Max per call"
          inputMode="numeric"
          value={form.maxPerRequest}
          onChange={set("maxPerRequest")}
          error={errors.maxPerRequest}
        />
        <Field
          label="Max per day"
          inputMode="numeric"
          value={form.maxPerDay}
          onChange={set("maxPerDay")}
          error={errors.maxPerDay}
          hint="UTC day."
        />
      </div>
    </fieldset>
  );
}

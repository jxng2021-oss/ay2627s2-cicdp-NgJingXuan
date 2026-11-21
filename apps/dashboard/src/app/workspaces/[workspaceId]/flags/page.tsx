"use client";

import Link from "next/link";
import { useId, useState, type FormEvent } from "react";
import {
  ArrowLink,
  Banner,
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  Loading,
  PageHeader,
  Status,
  formatDate,
} from "@/components/ui";
import { ApiError } from "@/lib/api/client";
import { workspace as api } from "@/lib/api/endpoints";
import { useToast } from "@/lib/toast";
import { useLoad } from "@/lib/use-load";
import { useWorkspace } from "@/lib/workspace";

const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ENVIRONMENTS = ["development", "staging", "production"] as const;

export default function FlagsPage() {
  const { id, isOwner } = useWorkspace();
  const toast = useToast();
  const flags = useLoad(() => api.flags(id), [id]);
  const [creating, setCreating] = useState(false);
  const [key, setKey] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<"boolean" | "string">("boolean");
  const [offText, setOffText] = useState("");
  const [keyError, setKeyError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const kindId = useId();

  function close() {
    setCreating(false);
    setKeyError(undefined);
    setFailure(undefined);
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!KEY_PATTERN.test(key)) {
      setKeyError(
        "Use 1 to 64 lowercase letters, digits, dots, dashes or underscores.",
      );
      return;
    }
    setKeyError(undefined);
    setBusy(true);
    setFailure(undefined);
    try {
      await api.createFlag(id, {
        key,
        description: description.trim(),
        kind,
        offValue: kind === "boolean" ? false : offText,
      });
      toast(`Flag ${key} created, off everywhere`);
      setKey("");
      setDescription("");
      close();
      flags.reload();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setKeyError("A flag with this key already exists.");
      } else {
        setFailure(error);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        label="App services"
        title="Feature flags"
        description="Turn features on per environment, for chosen users or a share of them. Apps ask for the values through the API."
        actions={
          isOwner && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              Create flag
            </Button>
          )
        }
      />
      {!isOwner && (
        <Banner title="Viewing as a member">
          Only workspace owners can create or change flags. You can test them.
        </Banner>
      )}

      {flags.status === "loading" && <Loading />}
      {flags.status === "error" && (
        <ErrorState error={flags.error} onRetry={flags.reload} />
      )}
      {flags.status === "ready" &&
        (flags.data.flags.length === 0 ? (
          <EmptyState>
            No flags yet.{" "}
            {isOwner
              ? "Create one to ship a feature switched off, then turn it on."
              : "An owner can create one."}
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Key</th>
                  <th scope="col">Kind</th>
                  {ENVIRONMENTS.map((environment) => (
                    <th scope="col" key={environment}>
                      {environment[0]!.toUpperCase() + environment.slice(1)}
                    </th>
                  ))}
                  <th scope="col">Changed</th>
                  <th scope="col">
                    <span className="sr-only">Details</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {flags.data.flags.map((flag) => (
                  <tr key={flag.key}>
                    <td data-label="Key">
                      <Link href={`/workspaces/${id}/flags/${flag.key}`}>
                        <code>{flag.key}</code>
                      </Link>
                      {flag.description && (
                        <p className="muted">{flag.description}</p>
                      )}
                    </td>
                    <td data-label="Kind">
                      {flag.kind === "boolean" ? "On/off" : "Text"}
                    </td>
                    {ENVIRONMENTS.map((environment) => (
                      <td data-label={environment} key={environment}>
                        {flag.environments[environment].enabled ? (
                          <Status tone="success">On</Status>
                        ) : (
                          <Status>Off</Status>
                        )}
                      </td>
                    ))}
                    <td data-label="Changed">{formatDate(flag.updatedAt)}</td>
                    <td className="actions">
                      <ArrowLink
                        href={`/workspaces/${id}/flags/${flag.key}`}
                        label={`Details of ${flag.key}`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

      <Dialog open={creating} title="Create flag" onClose={close}>
        <form
          className="form"
          onSubmit={(event) => void create(event)}
          noValidate
        >
          <Field
            label="Key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            hint="What your app asks for, like new-checkout. Can't be changed later."
            error={keyError}
            maxLength={64}
            autoFocus
          />
          <Field
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            hint="Optional: what the flag controls."
            maxLength={500}
          />
          <div className="field">
            <label htmlFor={kindId}>Kind</label>
            <select
              id={kindId}
              className="select"
              value={kind}
              onChange={(e) => setKind(e.target.value as "boolean" | "string")}
            >
              <option value="boolean">On/off (true or false)</option>
              <option value="string">Text (e.g. a variant name)</option>
            </select>
          </div>
          {kind === "string" && (
            <Field
              label="Value while off"
              value={offText}
              onChange={(e) => setOffText(e.target.value)}
              hint="What apps get while the flag is off, e.g. control."
              maxLength={200}
            />
          )}
          <p className="muted">
            New flags start off in every environment
            {kind === "boolean" ? ", serving false" : ""}.
          </p>
          <FormError error={failure} />
          <div className="form-actions">
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={busy}>
              {busy ? "Creating..." : "Create flag"}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

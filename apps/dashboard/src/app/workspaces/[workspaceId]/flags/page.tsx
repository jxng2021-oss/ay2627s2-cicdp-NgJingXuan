"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import {
  ArrowLink,
  Banner,
  Button,
  Card,
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
import { ApiError, type Flag, type FlagSettings } from "@/lib/api/client";
import { workspace as api } from "@/lib/api/endpoints";
import { useToast } from "@/lib/toast";
import { useLoad } from "@/lib/use-load";
import { useWorkspace } from "@/lib/workspace";

const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ENVIRONMENTS = ["development", "staging", "production"] as const;

const title = (environment: string) =>
  environment[0]!.toUpperCase() + environment.slice(1);

function environmentStatus(flag: Flag, settings: FlagSettings) {
  if (!settings.enabled) return <Status>Off</Status>;
  const targeted = settings.rules.length > 0 || settings.rollout;
  if (targeted) return <Status tone="info">On for some</Status>;
  if (flag.kind === "boolean" && settings.defaultValue === false) {
    return <Status tone="warning">On, nobody gets true</Status>;
  }
  return <Status tone="success">On for everyone</Status>;
}

function Guide() {
  const steps = [
    [
      "Create a flag",
      "Give it a name your code will use, like new-checkout. It starts off everywhere.",
    ],
    [
      "Ask for it in your app",
      "Your server asks the platform for the flag's value for each user, and shows the feature only when it's on.",
    ],
    [
      "Choose who gets it",
      "Turn it on per environment, for everyone or only for users you pick from your user pools. Changes apply right away.",
    ],
  ] as const;
  return (
    <Card title="How feature flags work">
      <ol className="flag-guide">
        {steps.map(([heading, text], index) => (
          <li key={heading}>
            <span className="flag-step-number" aria-hidden="true">
              {index + 1}
            </span>
            <div>
              <p>
                <strong>{heading}</strong>
              </p>
              <p className="muted body-6">{text}</p>
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

export default function FlagsPage() {
  const { id, isOwner } = useWorkspace();
  const toast = useToast();
  const router = useRouter();
  const flags = useLoad(() => api.flags(id), [id]);
  const [creating, setCreating] = useState(false);
  const [key, setKey] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<"boolean" | "string">("boolean");
  const [offText, setOffText] = useState("");
  const [keyError, setKeyError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>();

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
      router.push(`/workspaces/${id}/flags/${key}`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setKeyError("A flag with this name already exists.");
      } else {
        setFailure(error);
      }
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        label="App services"
        title="Feature flags"
        description="Ship a feature switched off, then turn it on from here, for everyone or only some users, without redeploying."
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
          Only workspace owners can create or change flags. You can check what
          users get.
        </Banner>
      )}

      <Guide />

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
                  <th scope="col">Flag</th>
                  <th scope="col">Type</th>
                  {ENVIRONMENTS.map((environment) => (
                    <th scope="col" key={environment}>
                      {title(environment)}
                    </th>
                  ))}
                  <th scope="col">Changed</th>
                  <th scope="col">
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {flags.data.flags.map((flag) => (
                  <tr key={flag.key}>
                    <td data-label="Flag">
                      <Link href={`/workspaces/${id}/flags/${flag.key}`}>
                        <code>{flag.key}</code>
                      </Link>
                      {flag.description && (
                        <p className="muted">{flag.description}</p>
                      )}
                    </td>
                    <td data-label="Type">
                      {flag.kind === "boolean" ? "Switch" : "Text"}
                    </td>
                    {ENVIRONMENTS.map((environment) => (
                      <td data-label={title(environment)} key={environment}>
                        {environmentStatus(
                          flag,
                          flag.environments[environment],
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
            label="Name"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            hint="What your code asks for, like new-checkout. Can't be changed later."
            error={keyError}
            maxLength={64}
            autoFocus
          />
          <Field
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            hint="Optional: what it controls, so your team knows."
            maxLength={500}
          />
          <fieldset className="flag-kinds">
            <legend className="sec-label">Type</legend>
            <label className="flag-kind">
              <input
                type="radio"
                name="kind"
                checked={kind === "boolean"}
                onChange={() => setKind("boolean")}
              />
              <span>
                <strong>On/off switch</strong>
                <span className="muted body-6">
                  Your app gets true or false. Most flags are this.
                </span>
              </span>
            </label>
            <label className="flag-kind">
              <input
                type="radio"
                name="kind"
                checked={kind === "string"}
                onChange={() => setKind("string")}
              />
              <span>
                <strong>Text</strong>
                <span className="muted body-6">
                  Your app gets a word you choose, like a variant name.
                </span>
              </span>
            </label>
          </fieldset>
          {kind === "string" && (
            <Field
              label="Value while off"
              value={offText}
              onChange={(e) => setOffText(e.target.value)}
              hint="What apps get while the flag is off, like control."
              maxLength={200}
            />
          )}
          <p className="muted">
            It starts off in every environment, so nothing changes for users
            {kind === "boolean" ? " (everyone gets false)" : ""} until you turn
            it on.
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

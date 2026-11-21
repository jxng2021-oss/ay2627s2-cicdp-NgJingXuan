"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import {
  EMPTY_POLICY,
  formToPolicy,
  PolicyFields,
  type PolicyForm,
} from "@/components/policy";
import {
  Banner,
  Button,
  Card,
  Field,
  FormError,
  PageHeader,
} from "@/components/ui";
import { workspace as api } from "@/lib/api/endpoints";
import { useToast } from "@/lib/toast";
import { useLoad } from "@/lib/use-load";
import { useWorkspace } from "@/lib/workspace";

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const HEADER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

export default function NewConnectionPage() {
  const { id, isOwner } = useWorkspace();
  const toast = useToast();
  const router = useRouter();
  const secrets = useLoad(() => api.secrets(id), [id]);
  const secretSelectId = useId();
  const [values, setValues] = useState({
    name: "",
    baseUrl: "",
    secretName: "",
    headerName: "Authorization",
    headerPrefix: "Bearer ",
  });
  const [policy, setPolicy] = useState<PolicyForm>(EMPTY_POLICY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const back = `/workspaces/${id}/connections`;
  const set =
    (key: keyof typeof values) => (event: { target: { value: string } }) =>
      setValues((current) => ({ ...current, [key]: event.target.value }));

  if (!isOwner) {
    return (
      <>
        <PageHeader label="Connections" title="Create connection" />
        <Banner title="Owners only">
          Only workspace owners can create connections.{" "}
          <Link href={back}>Back to connections</Link>
        </Banner>
      </>
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found: Record<string, string> = {};
    if (!NAME_PATTERN.test(values.name))
      found.name = "Use letters, digits, dots, dashes or underscores.";
    else if (values.name === "new")
      found.name = '"new" is reserved: choose another name.';
    try {
      const url = new URL(values.baseUrl);
      if (!["https:", "http:"].includes(url.protocol))
        throw new Error("scheme");
    } catch {
      found.baseUrl = "Enter a full URL, like https://api.example.com/v1.";
    }
    if (!NAME_PATTERN.test(values.secretName))
      found.secretName = "Choose one of your secrets.";
    if (!HEADER_PATTERN.test(values.headerName))
      found.headerName = "Enter a header name, like Authorization.";
    const checked = formToPolicy(policy);
    if ("errors" in checked) Object.assign(found, checked.errors);
    setErrors(found);
    if (Object.keys(found).length > 0 || "errors" in checked) {
      setFailure(undefined);
      return;
    }
    setBusy(true);
    setFailure(undefined);
    try {
      await api.saveConnection(id, values.name, {
        baseUrl: values.baseUrl,
        secretName: values.secretName,
        headerName: values.headerName,
        headerPrefix: values.headerPrefix,
        ...(checked.policy ? { policy: checked.policy } : {}),
      });
      toast(`Connection ${values.name} saved`);
      router.push(`${back}/${encodeURIComponent(values.name)}`);
    } catch (error) {
      setFailure(error);
      setBusy(false);
    }
  }

  const secretNames =
    secrets.status === "ready" ? secrets.data.secrets.map((s) => s.name) : [];

  return (
    <>
      <PageHeader
        label="Connections"
        title="Create connection"
        description="Apps call /v1/proxy/<name>/... with their API key; the platform adds your secret to the request and forwards it. The secret's value is never shown or returned."
        actions={
          <Link className="button" data-variant="ghost" href={back}>
            Cancel
          </Link>
        }
      />
      <form
        className="stack-6"
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        <Card title="Where it goes">
          <div className="form">
            <div className="stack-2">
              <p className="sec-label">Step 1</p>
              <h2>Where it goes</h2>
            </div>
            <Field
              label="Name"
              value={values.name}
              onChange={set("name")}
              error={errors.name}
              hint="Used in the proxy URL: /v1/proxy/<name>/..."
              autoFocus
            />
            <Field
              label="Base URL"
              type="url"
              value={values.baseUrl}
              onChange={set("baseUrl")}
              error={errors.baseUrl}
              hint="Only hosts the platform allows; https on servers."
            />
          </div>
        </Card>

        <Card title="Which secret">
          <div className="form">
            <div className="stack-2">
              <p className="sec-label">Step 2</p>
              <h2>Which secret, in which header</h2>
            </div>
            {secretNames.length > 0 ? (
              <div className="field">
                <label htmlFor={secretSelectId}>Secret</label>
                <select
                  id={secretSelectId}
                  className="select"
                  value={values.secretName}
                  onChange={set("secretName")}
                  aria-invalid={errors.secretName ? true : undefined}
                  aria-describedby={`${secretSelectId}-hint${errors.secretName ? ` ${secretSelectId}-error` : ""}`}
                >
                  <option value="">Choose a secret</option>
                  {secretNames.map((secretName) => (
                    <option key={secretName} value={secretName}>
                      {secretName}
                    </option>
                  ))}
                </select>
                <p className="hint" id={`${secretSelectId}-hint`}>
                  Its value goes in the header below (never shown here).
                </p>
                {errors.secretName && (
                  <p className="field-error" id={`${secretSelectId}-error`}>
                    {errors.secretName}
                  </p>
                )}
              </div>
            ) : (
              <Field
                label="Secret name"
                value={values.secretName}
                onChange={set("secretName")}
                error={errors.secretName}
                hint="The name of one of your secrets (create it on the Secrets page)."
              />
            )}
            <div className="policy-row">
              <Field
                label="Header name"
                value={values.headerName}
                onChange={set("headerName")}
                error={errors.headerName}
              />
              <Field
                label="Header prefix"
                value={values.headerPrefix}
                onChange={set("headerPrefix")}
                hint="Optional, like Bearer followed by a space."
              />
            </div>
          </div>
        </Card>

        <Card title="Policy">
          <div className="form">
            <div className="stack-2">
              <p className="sec-label">Step 3 (optional)</p>
              <h2>Limits</h2>
            </div>
            <PolicyFields form={policy} errors={errors} onChange={setPolicy} />
          </div>
        </Card>

        <FormError error={failure} />
        {Object.keys(errors).length > 0 && (
          <p className="field-error" role="alert">
            Check the highlighted fields above.
          </p>
        )}
        <div className="form-actions">
          <Link className="button" data-variant="ghost" href={back}>
            Cancel
          </Link>
          <Button variant="primary" type="submit" disabled={busy}>
            {busy ? "Saving..." : "Create connection"}
          </Button>
        </div>
      </form>
    </>
  );
}

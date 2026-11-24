"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useId, useState, type FormEvent } from "react";
import {
  Banner,
  Button,
  Card,
  ConfirmDialog,
  CopyButton,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  Loading,
  PageHeader,
  Status,
} from "@/components/ui";
import {
  UserPicker,
  type PickBy,
  type PickedUser,
} from "@/components/user-picker";
import {
  ApiError,
  type Flag,
  type FlagEnvironmentName,
  type FlagEvaluation,
  type FlagSettings,
} from "@/lib/api/client";
import { workspace as api } from "@/lib/api/endpoints";
import { apiUrl } from "@/lib/api/origin";
import { useToast } from "@/lib/toast";
import { useLoad } from "@/lib/use-load";
import { useWorkspace } from "@/lib/workspace";

const ENVIRONMENTS = ["development", "staging", "production"] as const;
const MAX_PER_RULE = 50;
type Value = boolean | string;

interface Target {
  by: PickBy;
  value: string;
  email: string | undefined;
  gets: Value;
}
interface Draft {
  enabled: boolean;
  targets: Target[];
  share: string;
  defaultValue: Value;
}

const title = (environment: string) =>
  environment[0]!.toUpperCase() + environment.slice(1);

function describeValue(kind: Flag["kind"], value: Value): string {
  if (kind === "boolean") return value === true ? "can see it" : "can't see it";
  return `get "${String(value)}"`;
}

function isTargetRule(rule: FlagSettings["rules"][number]): boolean {
  const [condition] = rule.conditions;
  return (
    rule.conditions.length === 1 &&
    (condition!.attribute === "key" || condition!.attribute === "email") &&
    (condition!.operator === "in" || condition!.operator === "equals")
  );
}

function toDraft(settings: FlagSettings): Draft {
  const targets: Target[] = [];
  let share = "";
  for (const rule of settings.rules.filter(isTargetRule)) {
    const condition = rule.conditions[0]!;
    for (const value of condition.values) {
      targets.push({
        by: condition.attribute === "key" ? "id" : "email",
        value,
        email: condition.attribute === "email" ? value : undefined,
        gets: rule.value,
      });
    }
    if (rule.percentage !== undefined && share === "") {
      share = String(rule.percentage);
    }
  }
  return {
    enabled: settings.enabled,
    targets,
    share,
    defaultValue: settings.defaultValue,
  };
}

function hasOlderSettings(settings: FlagSettings): boolean {
  return settings.rollout !== undefined || !settings.rules.every(isTargetRule);
}

function shareOf(text: string): number | undefined | null {
  if (text.trim() === "") return undefined;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function grants(kind: Flag["kind"], gets: Value, offValue: Value): boolean {
  return kind === "boolean" ? gets === true : gets !== offValue;
}

function toRules(
  flag: Flag,
  draft: Draft,
  share: number | undefined,
): FlagSettings["rules"] {
  const groups = new Map<
    string,
    { by: PickBy; gets: Value; values: string[] }
  >();
  const ordered = [...draft.targets].sort(
    (a, b) =>
      Number(grants(flag.kind, a.gets, flag.offValue)) -
      Number(grants(flag.kind, b.gets, flag.offValue)),
  );
  for (const target of ordered) {
    const name = `${target.by}:${JSON.stringify(target.gets)}`;
    const group = groups.get(name) ?? {
      by: target.by,
      gets: target.gets,
      values: [],
    };
    group.values.push(target.value);
    groups.set(name, group);
  }
  const rules: FlagSettings["rules"] = [];
  for (const group of groups.values()) {
    const partial =
      share !== undefined &&
      share < 100 &&
      grants(flag.kind, group.gets, flag.offValue);
    for (let start = 0; start < group.values.length; start += MAX_PER_RULE) {
      rules.push({
        conditions: [
          {
            attribute: group.by === "id" ? "key" : "email",
            operator: "in",
            values: group.values.slice(start, start + MAX_PER_RULE),
          },
        ],
        value: group.gets,
        ...(partial ? { percentage: share } : {}),
      });
    }
  }
  return rules;
}

function summary(flag: Flag, environment: string, draft: Draft): string[] {
  if (!draft.enabled) {
    return [
      `${title(environment)} is off: every user ${describeValue(flag.kind, flag.offValue)}.`,
    ];
  }
  const lines: string[] = [];
  const share = shareOf(draft.share);
  const byGets = new Map<string, Target[]>();
  for (const target of draft.targets) {
    const name = JSON.stringify(target.gets);
    byGets.set(name, [...(byGets.get(name) ?? []), target]);
  }
  for (const targets of byGets.values()) {
    const gets = targets[0]!.gets;
    const names = targets.map((t) => t.email ?? t.value);
    const who =
      names.length <= 3
        ? names.join(", ")
        : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
    const partial =
      share !== undefined &&
      share !== null &&
      share < 100 &&
      grants(flag.kind, gets, flag.offValue);
    lines.push(
      partial
        ? `${share}% of ${who} ${describeValue(flag.kind, gets)}; the rest are treated like everyone else.`
        : `${who} ${describeValue(flag.kind, gets)}.`,
    );
  }
  lines.push(
    `${lines.length > 0 ? "Everyone else" : "Every user"} ${describeValue(flag.kind, draft.defaultValue)}.`,
  );
  return lines;
}

export default function FlagPage() {
  const { key } = useParams<{ key: string }>();
  const { id, isOwner } = useWorkspace();
  const toast = useToast();
  const router = useRouter();
  const flag = useLoad(() => api.flag(id, key), [id, key]);
  const [environment, setEnvironment] =
    useState<FlagEnvironmentName>("production");
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>();

  if (flag.status === "loading") return <Loading />;
  if (flag.status === "error") {
    if (flag.error instanceof ApiError && flag.error.status === 404) {
      return (
        <EmptyState>
          This flag doesn&apos;t exist.{" "}
          <Link href={`/workspaces/${id}/flags`}>Back to feature flags</Link>
        </EmptyState>
      );
    }
    return <ErrorState error={flag.error} onRetry={flag.reload} />;
  }
  const data = flag.data;

  return (
    <>
      <PageHeader
        label="Feature flag"
        title={data.key}
        description={
          data.description ||
          (data.kind === "boolean"
            ? "An on/off switch: your app gets true or false."
            : "A text flag: your app gets one of the values you choose.")
        }
        actions={
          <Link
            className="button"
            data-variant="ghost"
            href={`/workspaces/${id}/flags`}
          >
            All flags
          </Link>
        }
      />
      {!isOwner && (
        <Banner title="Viewing as a member">
          Only workspace owners can change flags. You can check users below.
        </Banner>
      )}

      <div className="flag-environments">
        <p className="sec-label" id="environment-label">
          Environment
        </p>
        <div
          className="segmented"
          role="group"
          aria-labelledby="environment-label"
        >
          {ENVIRONMENTS.map((name) => (
            <button
              key={name}
              type="button"
              aria-pressed={environment === name}
              onClick={() => setEnvironment(name)}
            >
              <span
                className="flag-dot"
                data-on={data.environments[name].enabled}
                aria-hidden="true"
              />
              {title(name)}
              <span className="sr-only">
                ({data.environments[name].enabled ? "on" : "off"})
              </span>
            </button>
          ))}
        </div>
        <p className="muted body-6">
          Each environment has its own settings. Your app says which one it is
          when it asks.
        </p>
      </div>

      <EnvironmentEditor
        key={`${environment}-${data.updatedAt}`}
        flag={data}
        environment={environment}
        editable={isOwner}
        onSaved={(message) => {
          toast(message);
          flag.reload();
        }}
      />

      <TestPanel flag={data} environment={environment} />

      <UseInApp flag={data} environment={environment} />

      {isOwner && (
        <Card title="Delete flag">
          <div className="section">
            <h2>Delete flag</h2>
            <p className="muted">
              Apps asking for <code>{data.key}</code> stop getting it (it is
              left out of their answers). Remove it from your code first.
            </p>
            <div>
              <Button variant="danger" onClick={() => setDeleting(true)}>
                Delete flag
              </Button>
            </div>
          </div>
        </Card>
      )}

      <ConfirmDialog
        open={deleting}
        title="Delete flag"
        confirmLabel="Delete flag"
        busyLabel="Deleting..."
        busy={busy}
        error={failure}
        onConfirm={() => {
          setBusy(true);
          setFailure(undefined);
          api.deleteFlag(id, data.key).then(
            () => {
              toast(`Flag ${data.key} deleted`);
              router.replace(`/workspaces/${id}/flags`);
            },
            (error: unknown) => {
              setFailure(error);
              setBusy(false);
            },
          );
        }}
        onCancel={() => {
          setDeleting(false);
          setFailure(undefined);
        }}
      >
        <p>
          <strong>{data.key}</strong> is deleted in every environment. This
          can&apos;t be undone.
        </p>
      </ConfirmDialog>
    </>
  );
}

function StepTitle({ number, children }: { number: number; children: string }) {
  return (
    <h2 className="flag-step-title">
      <span className="flag-step-number" aria-hidden="true">
        {number}
      </span>
      {children}
    </h2>
  );
}

function ValueChoice({
  label,
  kind,
  value,
  onChange,
  disabled,
  hideLabel = false,
}: {
  label: string;
  kind: Flag["kind"];
  value: Value;
  onChange: (value: Value) => void;
  disabled: boolean;
  hideLabel?: boolean;
}) {
  const inputId = useId();
  return (
    <div className="field">
      <label htmlFor={inputId} className={hideLabel ? "sr-only" : undefined}>
        {label}
      </label>
      {kind === "boolean" ? (
        <select
          id={inputId}
          className="select"
          value={String(value)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value === "true")}
        >
          <option value="true">Can see it</option>
          <option value="false">Can&apos;t see it</option>
        </select>
      ) : (
        <input
          id={inputId}
          className="input"
          value={String(value)}
          maxLength={200}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}

function EnvironmentEditor({
  flag,
  environment,
  editable,
  onSaved,
}: {
  flag: Flag;
  environment: FlagEnvironmentName;
  editable: boolean;
  onSaved: (message: string) => void;
}) {
  const settings = flag.environments[environment];
  const { id } = useWorkspace();
  const [initial] = useState(() => JSON.stringify(toDraft(settings)));
  const [draft, setDraft] = useState<Draft>(() => toDraft(settings));
  const [picking, setPicking] = useState<PickBy>();
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const switchId = useId();
  const changed = JSON.stringify(draft) !== initial;
  const older = hasOlderSettings(settings);
  const see: Value = flag.kind === "boolean" ? true : "";

  const update = (change: Partial<Draft>) => setDraft({ ...draft, ...change });
  const setTarget = (index: number, change: Partial<Target>) =>
    update({
      targets: draft.targets.map((t, i) =>
        i === index ? { ...t, ...change } : t,
      ),
    });

  function add(users: PickedUser[]) {
    const known = new Set(draft.targets.map((t) => `${t.by}:${t.value}`));
    const added = users
      .map((user) => ({
        by: user.by,
        value: user.by === "id" ? user.id : user.email,
        email: user.email,
        gets: see,
      }))
      .filter((t) => !known.has(`${t.by}:${t.value}`));
    update({ targets: [...draft.targets, ...added] });
    setPicking(undefined);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    const share = shareOf(draft.share);
    if (share === null) {
      setProblem("The percentage must be 0 to 100.");
      return;
    }
    if (flag.kind === "string" && draft.targets.some((t) => t.gets === "")) {
      setProblem("Give every chosen user a value.");
      return;
    }
    const built: FlagSettings = {
      enabled: draft.enabled,
      rules: toRules(flag, draft, share),
      defaultValue: draft.defaultValue,
    };
    if (built.rules.length > 20) {
      setProblem("Too many users for one flag: choose fewer.");
      return;
    }
    setProblem(undefined);
    setBusy(true);
    setFailure(undefined);
    try {
      await api.setFlagEnvironment(id, flag.key, environment, built);
      onSaved(`${flag.key} saved in ${environment}`);
    } catch (error) {
      setFailure(error);
      setBusy(false);
    }
  }

  return (
    <Card title={`Who sees it in ${environment}`}>
      <form
        className="section form"
        onSubmit={(event) => void save(event)}
        noValidate
      >
        <div className="row row-between">
          <StepTitle number={1}>{`Who sees it in ${environment}`}</StepTitle>
          {settings.enabled ? (
            <Status tone="success">On</Status>
          ) : (
            <Status>Off</Status>
          )}
        </div>

        {older && (
          <Banner title="This flag has older settings">
            It also has rules on other attributes or a share of everyone else,
            which this page no longer shows. They keep working until you save
            here; saving replaces them with what you see below.
          </Banner>
        )}

        <div className="flag-switch" data-on={draft.enabled}>
          <input
            id={switchId}
            type="checkbox"
            role="switch"
            checked={draft.enabled}
            disabled={!editable}
            onChange={(e) => update({ enabled: e.target.checked })}
          />
          <label htmlFor={switchId}>
            <strong>Turn on in {environment}</strong>
            <span className="muted">
              {draft.enabled
                ? "On: the choices below decide who sees it."
                : `Off: every user ${describeValue(flag.kind, flag.offValue)}, and the choices below are ignored.`}
            </span>
          </label>
        </div>

        <ol className="flag-steps" data-off={!draft.enabled}>
          <li className="flag-step">
            <h3>Chosen users</h3>
            <p className="muted">
              Optional. Pick people from your user pools and decide, for each,
              whether they can see it. They come before everyone else.
            </p>
            {draft.targets.length === 0 ? (
              <p className="muted">Nobody chosen yet.</p>
            ) : (
              <div className="table-wrap">
                <table className="table" aria-label="Chosen users">
                  <thead>
                    <tr>
                      <th scope="col">User</th>
                      <th scope="col">Matched by</th>
                      <th scope="col">
                        {flag.kind === "boolean" ? "Can they see it?" : "Gets"}
                      </th>
                      <th scope="col">
                        <span className="sr-only">Remove</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {draft.targets.map((target, index) => (
                      <tr key={`${target.by}:${target.value}`}>
                        <td data-label="User">
                          {target.email ?? <code>{target.value}</code>}
                          {target.by === "id" && target.email && (
                            <p className="muted">
                              <code>{target.value}</code>
                            </p>
                          )}
                        </td>
                        <td data-label="Matched by">
                          {target.by === "id" ? "User ID" : "Email"}
                        </td>
                        <td data-label="Can they see it?">
                          <ValueChoice
                            label={`What ${target.email ?? target.value} gets`}
                            hideLabel
                            kind={flag.kind}
                            value={target.gets}
                            disabled={!editable}
                            onChange={(gets) => setTarget(index, { gets })}
                          />
                        </td>
                        <td className="actions">
                          {editable && (
                            <Button
                              variant="ghost"
                              aria-label={`Remove ${target.email ?? target.value}`}
                              onClick={() =>
                                update({
                                  targets: draft.targets.filter(
                                    (_, i) => i !== index,
                                  ),
                                })
                              }
                            >
                              Remove
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {editable && (
              <div className="row">
                <Button onClick={() => setPicking("email")}>
                  Add users by email
                </Button>
                <Button onClick={() => setPicking("id")}>
                  Add users by ID
                </Button>
              </div>
            )}
            {draft.targets.some((t) =>
              grants(flag.kind, t.gets, flag.offValue),
            ) && (
              <div className="flag-condition">
                <Field
                  label="How many of them can see it (%)"
                  type="number"
                  inputMode="decimal"
                  value={draft.share}
                  placeholder="100"
                  disabled={!editable}
                  hint="Of the chosen users marked can see it. Empty or 100: all of them; the rest are treated like everyone else."
                  onChange={(e) => update({ share: e.target.value })}
                />
              </div>
            )}
          </li>

          <li className="flag-step">
            <h3>Everyone else</h3>
            <div className="flag-condition">
              <ValueChoice
                label="Everyone else"
                kind={flag.kind}
                value={draft.defaultValue}
                disabled={!editable}
                onChange={(defaultValue) => update({ defaultValue })}
              />
            </div>
          </li>
        </ol>

        <div className="flag-summary">
          <p className="sec-label">In plain words</p>
          <ul>
            {summary(flag, environment, draft).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>

        {problem && (
          <p className="field-error" role="alert">
            {problem}
          </p>
        )}
        <FormError error={failure} />
        {editable && (
          <div className="form-actions flag-save">
            {changed && (
              <span className="muted body-6">
                Unsaved changes: users still get the saved settings.
              </span>
            )}
            <Button variant="primary" type="submit" disabled={busy}>
              {busy ? "Saving..." : `Save ${environment}`}
            </Button>
          </div>
        )}
      </form>
      <UserPicker
        by={picking}
        onClose={() => setPicking(undefined)}
        onAdd={add}
        chosen={draft.targets.map((t) => `${t.by}:${t.value}`)}
      />
    </Card>
  );
}

function TestPanel({
  flag,
  environment,
}: {
  flag: Flag;
  environment: FlagEnvironmentName;
}) {
  const { id } = useWorkspace();
  const [userId, setUserId] = useState("");
  const [email, setEmail] = useState("");
  const [result, setResult] = useState<FlagEvaluation["flags"][string]>();
  const [failure, setFailure] = useState<unknown>();

  useEffect(() => setResult(undefined), [environment, flag.updatedAt]);

  async function test(event: FormEvent) {
    event.preventDefault();
    setFailure(undefined);
    try {
      const answer = await api.testFlags(id, {
        environment,
        context: {
          key: userId.trim() || "anonymous",
          attributes: email.trim() ? { email: email.trim() } : {},
        },
        keys: [flag.key],
      });
      setResult(answer.flags[flag.key]);
    } catch (error) {
      setFailure(error);
    }
  }

  const reasons = {
    off: `the flag is off in ${environment}`,
    rule: "they are one of the chosen users",
    rollout: "they are in the share of everyone else",
    default: "they aren't a chosen user, so they get what everyone else gets",
  } as const;

  return (
    <Card title="Check a user">
      <form
        className="section form"
        onSubmit={(event) => void test(event)}
        noValidate
      >
        <StepTitle number={2}>Check a user</StepTitle>
        <p className="muted">
          See what {environment} gives someone right now (saved settings only),
          as your app would see it.
        </p>
        <div className="flag-condition">
          <Field
            label="User ID"
            value={userId}
            placeholder="the user's ID"
            onChange={(e) => setUserId(e.target.value)}
            maxLength={200}
          />
          <Field
            label="Email"
            type="email"
            value={email}
            placeholder="ada@example.com"
            onChange={(e) => setEmail(e.target.value)}
            maxLength={200}
          />
        </div>
        <FormError error={failure} />
        <div className="form-actions">
          <Button type="submit" variant="primary">
            Check
          </Button>
        </div>
        {result && (
          <div className="flag-result" role="status">
            <p className="sec-label">Result</p>
            <p>
              {flag.kind === "boolean" ? (
                <strong>
                  {result.value === true ? "Can see it" : "Can't see it"}
                </strong>
              ) : (
                <>
                  Gets <code>&quot;{String(result.value)}&quot;</code>
                </>
              )}
              , because {reasons[result.reason]}.
            </p>
          </div>
        )}
      </form>
    </Card>
  );
}

function UseInApp({
  flag,
  environment,
}: {
  flag: Flag;
  environment: FlagEnvironmentName;
}) {
  const use =
    flag.kind === "boolean"
      ? `if (await flags.isOn("${flag.key}", user)) {
  // show the new feature
}`
      : `const variant = await flags.value("${flag.key}", user, ${JSON.stringify(flag.offValue)});`;
  const code = `const { SecureCloud } = require("@secure-cloud/sdk");

const flags = new SecureCloud().flags("${environment}");

// in a route, for the signed in user:
const user = { id: req.user.id, email: req.user.email };
${use}`;
  return (
    <Card title="Read it in your app">
      <div className="section">
        <div className="row row-between">
          <StepTitle number={3}>Read it in your app</StepTitle>
          <CopyButton value={code} label="Copy the code" />
        </div>
        <p className="muted">
          Your app&apos;s server asks on each request, with the SDK. Set{" "}
          <code>SECURE_CLOUD_API_KEY</code> (from API keys, never in the
          browser) and <code>SECURE_CLOUD_URL={apiUrl("")}</code>. Pass the
          user&apos;s ID from the user pool and their email, so the users you
          chose are recognised. Changes here apply on the next request: no
          redeploy. More in the{" "}
          <Link href="/docs/flags">feature flags docs</Link>.
        </p>
        <pre className="code-block">
          <code>{code}</code>
        </pre>
      </div>
    </Card>
  );
}

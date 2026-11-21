"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useId, useState, type FormEvent } from "react";
import {
  Banner,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  Loading,
  PageHeader,
  Status,
} from "@/components/ui";
import {
  ApiError,
  type Flag,
  type FlagEnvironmentName,
  type FlagEvaluation,
  type FlagSettings,
} from "@/lib/api/client";
import { workspace as api } from "@/lib/api/endpoints";
import { useToast } from "@/lib/toast";
import { useLoad } from "@/lib/use-load";
import { useWorkspace } from "@/lib/workspace";

const ENVIRONMENTS = ["development", "staging", "production"] as const;
const OPERATORS = [
  ["equals", "equals"],
  ["not_equals", "doesn't equal"],
  ["in", "is one of"],
  ["not_in", "is none of"],
  ["contains", "contains"],
  ["starts_with", "starts with"],
  ["greater_than", "is greater than"],
  ["less_than", "is less than"],
] as const;
type Operator = (typeof OPERATORS)[number][0];
type Value = boolean | string;

interface RuleDraft {
  conditions: { attribute: string; operator: Operator; values: string }[];
  value: Value;
  percentage: string;
}

const title = (environment: string) =>
  environment[0]!.toUpperCase() + environment.slice(1);

function toDrafts(settings: FlagSettings): RuleDraft[] {
  return settings.rules.map((rule) => ({
    conditions: rule.conditions.map((condition) => ({
      attribute: condition.attribute,
      operator: condition.operator,
      values: condition.values.join(", "),
    })),
    value: rule.value,
    percentage: rule.percentage === undefined ? "" : String(rule.percentage),
  }));
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
        description={data.description || "No description."}
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
          Only workspace owners can change flags. You can test them below.
        </Banner>
      )}

      <div className="segmented" role="group" aria-label="Environment">
        {ENVIRONMENTS.map((name) => (
          <button
            key={name}
            type="button"
            aria-pressed={environment === name}
            onClick={() => setEnvironment(name)}
          >
            {title(name)}{" "}
            <span className="sr-only">
              ({data.environments[name].enabled ? "on" : "off"})
            </span>
          </button>
        ))}
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

      {isOwner && (
        <Card title="Delete flag">
          <div className="section">
            <h2>Delete flag</h2>
            <p className="muted">
              Apps asking for <code>{data.key}</code> stop getting it (it is
              left out of their answers). Make sure no code still needs it.
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

function ValueInput({
  label,
  kind,
  value,
  onChange,
  disabled,
}: {
  label: string;
  kind: Flag["kind"];
  value: Value;
  onChange: (value: Value) => void;
  disabled: boolean;
}) {
  const inputId = useId();
  return (
    <div className="field">
      <label htmlFor={inputId}>{label}</label>
      {kind === "boolean" ? (
        <select
          id={inputId}
          className="select"
          value={String(value)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value === "true")}
        >
          <option value="true">true</option>
          <option value="false">false</option>
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
  const [enabled, setEnabled] = useState(settings.enabled);
  const [rules, setRules] = useState<RuleDraft[]>(() => toDrafts(settings));
  const [rollout, setRollout] = useState(
    settings.rollout ? String(settings.rollout.percentage) : "",
  );
  const [rolloutValue, setRolloutValue] = useState<Value>(
    settings.rollout?.value ?? (flag.kind === "boolean" ? true : ""),
  );
  const [defaultValue, setDefaultValue] = useState<Value>(
    settings.defaultValue,
  );
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const switchId = useId();
  const [removingRule, setRemovingRule] = useState<number>();
  const newValue: Value = flag.kind === "boolean" ? true : "";

  function updateRule(index: number, change: Partial<RuleDraft>) {
    setRules(
      rules.map((rule, i) => (i === index ? { ...rule, ...change } : rule)),
    );
  }

  function percentage(text: string): number | undefined | null {
    if (text.trim() === "") return undefined;
    const value = Number(text);
    return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    const built: FlagSettings = { enabled, rules: [], defaultValue };
    for (const [index, rule] of rules.entries()) {
      const share = percentage(rule.percentage);
      if (share === null) {
        setProblem(`Rule ${index + 1}: the percentage must be 0 to 100.`);
        return;
      }
      const conditions = rule.conditions.map((condition) => ({
        attribute: condition.attribute.trim(),
        operator: condition.operator,
        values: condition.values
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      }));
      if (
        conditions.some(
          (c) =>
            !/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(c.attribute) ||
            c.values.length === 0,
        )
      ) {
        setProblem(
          `Rule ${index + 1}: every condition needs an attribute name (letters, digits, _) and at least one value.`,
        );
        return;
      }
      built.rules.push({
        conditions,
        value: rule.value,
        ...(share === undefined ? {} : { percentage: share }),
      });
    }
    const share = percentage(rollout);
    if (share === null) {
      setProblem("The rollout percentage must be 0 to 100.");
      return;
    }
    if (share !== undefined)
      built.rollout = { percentage: share, value: rolloutValue };
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
    <Card title={`${title(environment)} settings`}>
      <form
        className="section form"
        onSubmit={(event) => void save(event)}
        noValidate
      >
        <div className="row row-between">
          <h2>{title(environment)}</h2>
          {settings.enabled ? (
            <Status tone="success">On</Status>
          ) : (
            <Status>Off</Status>
          )}
        </div>
        <div className="checkbox-field">
          <input
            id={switchId}
            type="checkbox"
            checked={enabled}
            disabled={!editable}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <label htmlFor={switchId}>
            Flag is on in {environment} (off: everyone gets{" "}
            <code>{String(flag.offValue)}</code>)
          </label>
        </div>

        <fieldset className="policy-fields">
          <legend className="sec-label">
            Targeting rules (first match wins)
          </legend>
          {rules.length === 0 && <p className="muted">No rules.</p>}
          {rules.map((rule, index) => (
            <div className="flag-rule" key={index}>
              <p className="sec-label">Rule {index + 1}</p>
              {rule.conditions.map((condition, c) => (
                <div className="flag-condition" key={c}>
                  <Field
                    label="Attribute"
                    value={condition.attribute}
                    disabled={!editable}
                    hint={
                      c === 0
                        ? 'e.g. country, plan; "key" is the user\'s key'
                        : undefined
                    }
                    onChange={(e) =>
                      updateRule(index, {
                        conditions: rule.conditions.map((x, i) =>
                          i === c ? { ...x, attribute: e.target.value } : x,
                        ),
                      })
                    }
                  />
                  <OperatorSelect
                    value={condition.operator}
                    disabled={!editable}
                    onChange={(operator) =>
                      updateRule(index, {
                        conditions: rule.conditions.map((x, i) =>
                          i === c ? { ...x, operator } : x,
                        ),
                      })
                    }
                  />
                  <Field
                    label="Values"
                    value={condition.values}
                    disabled={!editable}
                    hint="Comma-separated"
                    onChange={(e) =>
                      updateRule(index, {
                        conditions: rule.conditions.map((x, i) =>
                          i === c ? { ...x, values: e.target.value } : x,
                        ),
                      })
                    }
                  />
                </div>
              ))}
              <div className="flag-condition">
                <ValueInput
                  label="Serve"
                  kind={flag.kind}
                  value={rule.value}
                  disabled={!editable}
                  onChange={(value) => updateRule(index, { value })}
                />
                <Field
                  label="To this share (%)"
                  type="number"
                  inputMode="decimal"
                  value={rule.percentage}
                  disabled={!editable}
                  hint="Empty: everyone matching"
                  onChange={(e) =>
                    updateRule(index, { percentage: e.target.value })
                  }
                />
              </div>
              {editable && (
                <div className="row">
                  <Button
                    onClick={() =>
                      updateRule(index, {
                        conditions: [
                          ...rule.conditions,
                          { attribute: "", operator: "equals", values: "" },
                        ],
                      })
                    }
                  >
                    Add condition
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => setRemovingRule(index)}
                  >
                    Remove rule {index + 1}
                  </Button>
                </div>
              )}
            </div>
          ))}
          {editable && (
            <div>
              <Button
                onClick={() =>
                  setRules([
                    ...rules,
                    {
                      conditions: [
                        { attribute: "", operator: "equals", values: "" },
                      ],
                      value: newValue,
                      percentage: "",
                    },
                  ])
                }
              >
                Add rule
              </Button>
            </div>
          )}
        </fieldset>

        <div className="flag-condition">
          <Field
            label="Percentage rollout (%)"
            type="number"
            inputMode="decimal"
            value={rollout}
            disabled={!editable}
            hint="After the rules: this share of everyone else. Empty: none."
            onChange={(e) => setRollout(e.target.value)}
          />
          <ValueInput
            label="Rollout serves"
            kind={flag.kind}
            value={rolloutValue}
            disabled={!editable}
            onChange={setRolloutValue}
          />
          <ValueInput
            label="Everyone else gets"
            kind={flag.kind}
            value={defaultValue}
            disabled={!editable}
            onChange={setDefaultValue}
          />
        </div>

        {problem && (
          <p className="field-error" role="alert">
            {problem}
          </p>
        )}
        <FormError error={failure} />
        <ConfirmDialog
          open={removingRule !== undefined}
          title="Remove rule"
          confirmLabel="Remove rule"
          busyLabel="Removing..."
          busy={false}
          onConfirm={() => {
            setRules(rules.filter((_, i) => i !== removingRule));
            setRemovingRule(undefined);
          }}
          onCancel={() => setRemovingRule(undefined)}
        >
          <p>
            Rule {(removingRule ?? 0) + 1} is taken out of the form. Nothing
            changes for users until you save.
          </p>
        </ConfirmDialog>
        {editable && (
          <div className="form-actions">
            <Button variant="primary" type="submit" disabled={busy}>
              {busy ? "Saving..." : `Save ${environment}`}
            </Button>
          </div>
        )}
      </form>
    </Card>
  );
}

function OperatorSelect({
  value,
  onChange,
  disabled,
}: {
  value: Operator;
  onChange: (operator: Operator) => void;
  disabled: boolean;
}) {
  const selectId = useId();
  return (
    <div className="field">
      <label htmlFor={selectId}>Operator</label>
      <select
        id={selectId}
        className="select"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as Operator)}
      >
        {OPERATORS.map(([operator, label]) => (
          <option key={operator} value={operator}>
            {label}
          </option>
        ))}
      </select>
    </div>
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
  const [userKey, setUserKey] = useState("user-123");
  const [attributes, setAttributes] = useState("country=SG");
  const [result, setResult] = useState<FlagEvaluation["flags"][string]>();
  const [problem, setProblem] = useState<string>();
  const [failure, setFailure] = useState<unknown>();
  const attributesId = useId();

  useEffect(() => setResult(undefined), [environment, flag.updatedAt]);

  async function test(event: FormEvent) {
    event.preventDefault();
    const parsed: Record<string, string> = {};
    for (const line of attributes
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)) {
      const [name, ...rest] = line.split("=");
      if (
        !name ||
        rest.length === 0 ||
        !/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name.trim())
      ) {
        setProblem(`"${line}" isn't name=value.`);
        return;
      }
      parsed[name.trim()] = rest.join("=").trim();
    }
    setProblem(undefined);
    setFailure(undefined);
    try {
      const answer = await api.testFlags(id, {
        environment,
        context: { key: userKey.trim() || "anonymous", attributes: parsed },
        keys: [flag.key],
      });
      setResult(answer.flags[flag.key]);
    } catch (error) {
      setFailure(error);
    }
  }

  const reasons = {
    off: "the flag is off in this environment",
    rule: "a targeting rule matched",
    rollout: "the user is in the percentage rollout",
    default: "no rule matched and they're not in the rollout",
  } as const;

  return (
    <Card title="Test a user">
      <form
        className="section form"
        onSubmit={(event) => void test(event)}
        noValidate
      >
        <h2>Test a user</h2>
        <p className="muted">
          What {environment} serves this user right now, as an app would see it.
        </p>
        <Field
          label="User key"
          value={userKey}
          onChange={(e) => setUserKey(e.target.value)}
          hint="Usually the user's ID; percentages are stable per key."
          maxLength={200}
        />
        <div className="field">
          <label htmlFor={attributesId}>Attributes</label>
          <textarea
            id={attributesId}
            className="input textarea"
            rows={3}
            value={attributes}
            onChange={(e) => setAttributes(e.target.value)}
          />
          <p className="hint">One name=value per line, e.g. plan=pro.</p>
        </div>
        {problem && (
          <p className="field-error" role="alert">
            {problem}
          </p>
        )}
        <FormError error={failure} />
        <div className="form-actions">
          <Button type="submit">Test</Button>
        </div>
        {result && (
          <p role="status">
            Serves <code>{String(result.value)}</code>:{" "}
            {result.reason === "rule"
              ? `rule ${(result.ruleIndex ?? 0) + 1} matched`
              : reasons[result.reason]}
            .
          </p>
        )}
      </form>
    </Card>
  );
}

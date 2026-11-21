"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ApiError } from "@/lib/api/client";
import { auth } from "@/lib/api/endpoints";
import { safeNext } from "@/lib/safe-redirect";
import { useMarkSignedIn } from "@/lib/session";
import { FEATURES } from "@/lib/features";
import { Icon } from "./icons";
import { GatewayMock } from "./marketing/gateway-mock";
import { Button, Field, FormError } from "./ui";

const MIN_PASSWORD = 12;

export function AuthForm({ mode }: { mode: "login" | "sign-up" }) {
  const router = useRouter();
  const next = safeNext(useSearchParams().get("next"));
  const markSignedIn = useMarkSignedIn();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const signUp = mode === "sign-up";

  function validate(): Record<string, string> {
    const found: Record<string, string> = {};
    if (!/^[^\s@]+@[^\s@]+$/.test(email.trim()))
      found.email = "Enter an email address, like you@example.com.";
    if (signUp && password.length < MIN_PASSWORD) {
      found.password = `Use at least ${MIN_PASSWORD} characters.`;
    } else if (!password) {
      found.password = "Enter your password.";
    }
    if (signUp && !workspaceName.trim())
      found.workspaceName = "Name your first workspace.";
    return found;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found = validate();
    setErrors(found);
    setFailure(undefined);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    try {
      const me = signUp
        ? await auth.signUp({
            email: email.trim(),
            password,
            workspaceName: workspaceName.trim(),
          })
        : await auth.login({ email: email.trim(), password });
      setPassword("");
      markSignedIn(true);
      const created = signUp ? me.workspaces[0] : undefined;
      router.replace(
        next !== "/"
          ? next
          : created
            ? `/workspaces/${created.id}`
            : "/workspaces",
      );
    } catch (error) {
      setBusy(false);
      if (
        error instanceof ApiError &&
        error.code === "BAD_REQUEST" &&
        /password/i.test(error.message)
      ) {
        setErrors({ password: error.message });
      } else if (error instanceof ApiError && error.code === "CONFLICT") {
        setErrors({
          email: "An account with this email already exists. Log in instead.",
        });
      } else {
        setFailure(error);
      }
    }
  }

  return (
    <main className="auth-split">
      <AuthAside signUp={signUp} />
      <section className="auth-panel" aria-labelledby="auth-title">
        <div className="auth-form-card">
          <Link href="/" className="auth-back body-5">
            <Icon name="arrow-left" /> Back to home
          </Link>
          <div className="section">
            <h1 id="auth-title" className="heading-4">
              {signUp ? "Create your workspace" : "Log in"}
            </h1>
            <p className="muted body-6">
              {signUp
                ? "Your account comes with its first workspace. You'll be its owner."
                : "Log in to manage your workspace's keys, secrets and files."}
            </p>
          </div>
          <form
            className="form"
            onSubmit={(event) => void submit(event)}
            noValidate
          >
            <Field
              label="Email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={errors.email}
              required
            />
            <Field
              label="Password"
              type="password"
              autoComplete={signUp ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              hint={
                signUp
                  ? `At least ${MIN_PASSWORD} characters. Common passwords are refused.`
                  : undefined
              }
              error={errors.password}
              maxLength={128}
              required
            />
            {signUp && (
              <Field
                label="Workspace name"
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
                error={errors.workspaceName}
                maxLength={100}
                required
              />
            )}
            <FormError error={failure} />
            <Button variant="primary" type="submit" disabled={busy}>
              {busy
                ? signUp
                  ? "Creating your workspace..."
                  : "Logging in..."
                : signUp
                  ? "Create your workspace"
                  : "Log in"}
            </Button>
          </form>
          <p className="muted body-6">
            {signUp ? "Already have an account? " : "New here? "}
            <Link href={signUp ? "/login" : "/sign-up"}>
              {signUp ? "Log in" : "Create an account"}
            </Link>
          </p>
        </div>
      </section>
    </main>
  );
}

function AuthAside({ signUp }: { signUp: boolean }) {
  const highlights = FEATURES.filter((f) =>
    signUp
      ? ["secrets", "connections", "files"].includes(f.id)
      : ["connections", "audit", "keys"].includes(f.id),
  );
  return (
    <aside className="auth-aside" aria-label="About secure-cloud">
      <Link href="/" className="wordmark">
        secure-cloud
      </Link>
      <div className="auth-aside-copy">
        <p className="eyebrow">
          {signUp ? "Free, no card needed" : "Welcome back"}
        </p>
        <p className="auth-aside-title heading-4">
          {signUp
            ? "Your apps call any API. They never hold the key."
            : "Your keys stayed sealed while you were away."}
        </p>
        <ul className="auth-highlights body-6">
          {highlights.map((feature) => (
            <li key={feature.id} data-feature={feature.id}>
              <span className="feature-tile">
                <Icon name={feature.icon} size={14} />
              </span>
              <span>
                <strong>{feature.name}.</strong>{" "}
                <span className="muted">{feature.tagline}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <GatewayMock />
    </aside>
  );
}

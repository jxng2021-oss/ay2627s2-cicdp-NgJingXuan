"use client";

import Link from "next/link";
import { useActionState, useId, useState, type FormEvent } from "react";
import { ErrorBanner } from "@/components/ui";
import { signIn, signUp, type AccountState } from "./actions";

export function AccountForm({
  mode,
  next,
}: {
  mode: "sign-in" | "sign-up";
  next?: string;
}) {
  const [state, action, pending] = useActionState<AccountState, FormData>(
    mode === "sign-in" ? signIn : signUp,
    {},
  );
  const emailId = useId();
  const passwordId = useId();
  const hintId = useId();
  const emailErrorId = useId();
  const passwordErrorId = useId();
  const [problems, setProblems] = useState<{
    email?: string;
    password?: string;
  }>({});

  function check(event: FormEvent<HTMLFormElement>) {
    const form = new FormData(event.currentTarget);
    const text = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" ? value : "";
    };
    const email = text("email").trim();
    const password = text("password");
    const found: typeof problems = {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      found.email = "Enter an email address, like you@example.com.";
    }
    if (!password) {
      found.password = "Enter your password.";
    } else if (mode === "sign-up" && password.length < 12) {
      found.password = "Use at least 12 characters.";
    }
    setProblems(found);
    if (found.email || found.password) event.preventDefault();
  }
  const label = mode === "sign-in" ? "Sign In" : "Create Account";
  const query = next ? `?next=${encodeURIComponent(next)}` : "";
  return (
    <form action={action} onSubmit={check} className="form" noValidate>
      {next && <input type="hidden" name="next" value={next} />}
      <div className="field">
        <label htmlFor={emailId}>Email</label>
        <input
          id={emailId}
          name="email"
          type="email"
          autoComplete="email"
          className="input"
          defaultValue={state.email}
          aria-invalid={problems.email ? true : undefined}
          aria-describedby={problems.email ? emailErrorId : undefined}
        />
        {problems.email && (
          <p className="field-error" id={emailErrorId}>
            {problems.email}
          </p>
        )}
      </div>
      <div className="field">
        <label htmlFor={passwordId}>Password</label>
        <input
          id={passwordId}
          name="password"
          type="password"
          autoComplete={
            mode === "sign-in" ? "current-password" : "new-password"
          }
          className="input"
          aria-invalid={problems.password ? true : undefined}
          aria-describedby={
            [
              mode === "sign-up" ? hintId : "",
              problems.password ? passwordErrorId : "",
            ]
              .filter(Boolean)
              .join(" ") || undefined
          }
        />
        {problems.password && (
          <p className="field-error" id={passwordErrorId}>
            {problems.password}
          </p>
        )}
        {mode === "sign-up" && (
          <p className="hint" id={hintId}>
            At least 12 characters.
          </p>
        )}
      </div>
      {state.error && <ErrorBanner error={state.error} />}
      <div className="form-actions">
        <button
          type="submit"
          className="button"
          data-variant="primary"
          disabled={pending}
        >
          {pending ? "One moment..." : label}
        </button>
      </div>
      <p className="muted">
        {mode === "sign-in" ? (
          <>
            New here?{" "}
            <Link href={`/account/sign-up${query}`}>Create an account</Link>
          </>
        ) : (
          <>
            Have an account?{" "}
            <Link href={`/account/sign-in${query}`}>Sign in</Link>
          </>
        )}
      </p>
    </form>
  );
}

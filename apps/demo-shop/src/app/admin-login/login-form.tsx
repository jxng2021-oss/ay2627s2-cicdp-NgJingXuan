"use client";

import { useActionState, useId, useState, type FormEvent } from "react";
import { adminSignIn, type AdminLoginState } from "./actions";

export function AdminLoginForm({ next }: { next?: string }) {
  const [state, action, pending] = useActionState<AdminLoginState, FormData>(
    adminSignIn,
    {},
  );
  const [problem, setProblem] = useState<string>();
  const passwordId = useId();
  const errorId = useId();
  const error = problem ?? state.error;

  function check(event: FormEvent<HTMLFormElement>) {
    const password = new FormData(event.currentTarget).get("password");
    if (typeof password !== "string" || password === "") {
      event.preventDefault();
      setProblem("Enter the admin password.");
    } else {
      setProblem(undefined);
    }
  }

  return (
    <form action={action} onSubmit={check} className="form" noValidate>
      {next && <input type="hidden" name="next" value={next} />}
      <div className="field">
        <label htmlFor={passwordId}>Admin password</label>
        <input
          id={passwordId}
          name="password"
          type="password"
          autoComplete="current-password"
          className="input"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          autoFocus
        />
        {error && (
          <p className="field-error" id={errorId} role="alert">
            {error}
          </p>
        )}
        <p className="hint">
          SHOP_ADMIN_PASSWORD in .local/demo-shop.env, written by pnpm
          demo:setup.
        </p>
      </div>
      <div className="form-actions">
        <button
          type="submit"
          className="button"
          data-variant="primary"
          disabled={pending}
        >
          {pending ? "One moment..." : "Sign in"}
        </button>
      </div>
    </form>
  );
}

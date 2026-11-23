"use client";

import { useActionState, useId } from "react";
import { ErrorBanner } from "@/components/ui";
import { choosePassword, type AccountState } from "../actions";

export function NewPasswordForm() {
  const [state, action, pending] = useActionState<AccountState, FormData>(
    choosePassword,
    {},
  );
  const currentId = useId();
  const newId = useId();
  const confirmId = useId();
  const hintId = useId();
  return (
    <form action={action} className="form">
      <div className="field">
        <label htmlFor={currentId}>Current password</label>
        <input
          id={currentId}
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          className="input"
          required
        />
      </div>
      <div className="field">
        <label htmlFor={newId}>New password</label>
        <input
          id={newId}
          name="newPassword"
          type="password"
          autoComplete="new-password"
          className="input"
          minLength={12}
          required
          aria-describedby={hintId}
        />
        <p className="hint" id={hintId}>
          At least 12 characters.
        </p>
      </div>
      <div className="field">
        <label htmlFor={confirmId}>Confirm new password</label>
        <input
          id={confirmId}
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          className="input"
          minLength={12}
          required
        />
      </div>
      {state.error && <ErrorBanner error={state.error} />}
      <div className="form-actions">
        <button
          type="submit"
          className="button"
          data-variant="primary"
          disabled={pending}
        >
          {pending ? "One moment..." : "Save New Password"}
        </button>
      </div>
    </form>
  );
}

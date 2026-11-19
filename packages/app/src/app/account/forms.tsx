"use client";

import { useActionState } from "react";
import { changeEmail, changePassword, regenerateBackupCodes, type FormState } from "./actions.ts";

function Result({ state }: { state: FormState }) {
  if (state.error)
    return (
      <p className="error" role="alert">
        {state.error}
      </p>
    );
  if (!state.ok) return null;
  return (
    <div className="notice" role="status">
      <p>{state.ok}</p>
      {state.codes && (
        <ul className="codes">
          {state.codes.map((c) => (
            <li key={c}>
              <code>{c}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function EmailForm({ current }: { current: string }) {
  const [state, action, pending] = useActionState(changeEmail, {});
  return (
    <form action={action} className="stack">
      <Result state={state} />
      <label>
        New email address
        <input name="newEmail" type="email" autoComplete="email" required placeholder={current} />
      </label>
      <button type="submit" disabled={pending}>
        Change email
      </button>
    </form>
  );
}

export function PasswordForm() {
  const [state, action, pending] = useActionState(changePassword, {});
  return (
    <form action={action} className="stack">
      <Result state={state} />
      <label>
        Current password
        <input name="currentPassword" type="password" autoComplete="current-password" required />
      </label>
      <label>
        New password (12 characters or more)
        <input name="newPassword" type="password" autoComplete="new-password" minLength={12} required />
      </label>
      <label>
        New password again
        <input name="confirmPassword" type="password" autoComplete="new-password" minLength={12} required />
      </label>
      <button type="submit" disabled={pending}>
        Change password
      </button>
    </form>
  );
}

export function BackupCodesForm() {
  const [state, action, pending] = useActionState(regenerateBackupCodes, {});
  return (
    <form action={action} className="stack">
      <Result state={state} />
      <label>
        Current password
        <input name="password" type="password" autoComplete="current-password" required />
      </label>
      <button type="submit" disabled={pending}>
        New backup codes
      </button>
    </form>
  );
}

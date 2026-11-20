"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { changeEmail, changePassword, regenerateBackupCodes, type FormState } from "./actions.ts";

function Result({ state }: { state: FormState }) {
  const t = useTranslations("account");
  if (state.error)
    return (
      <p className="error" role="alert">
        {t(state.error as never, state.values as never)}
      </p>
    );
  if (!state.ok) return null;
  return (
    <div className="notice" role="status">
      <p>{t(state.ok as never)}</p>
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
  const t = useTranslations("account");
  const [state, action, pending] = useActionState(changeEmail, {});
  return (
    <form action={action} className="stack">
      <Result state={state} />
      <label>
        {t("newEmail")}
        <input name="newEmail" type="email" autoComplete="email" required placeholder={current} />
      </label>
      <button type="submit" disabled={pending}>
        {t("changeEmail")}
      </button>
    </form>
  );
}

export function PasswordForm() {
  const t = useTranslations("account");
  const [state, action, pending] = useActionState(changePassword, {});
  return (
    <form action={action} className="stack">
      <Result state={state} />
      <label>
        {t("currentPassword")}
        <input name="currentPassword" type="password" autoComplete="current-password" required />
      </label>
      <label>
        {t("newPassword")}
        <input name="newPassword" type="password" autoComplete="new-password" minLength={12} required />
      </label>
      <label>
        {t("newPasswordAgain")}
        <input name="confirmPassword" type="password" autoComplete="new-password" minLength={12} required />
      </label>
      <button type="submit" disabled={pending}>
        {t("changePassword")}
      </button>
    </form>
  );
}

export function BackupCodesForm() {
  const t = useTranslations("account");
  const [state, action, pending] = useActionState(regenerateBackupCodes, {});
  return (
    <form action={action} className="stack">
      <Result state={state} />
      <label>
        {t("currentPassword")}
        <input name="password" type="password" autoComplete="current-password" required />
      </label>
      <button type="submit" disabled={pending}>
        {t("newBackup")}
      </button>
    </form>
  );
}

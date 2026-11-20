"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { PASSWORD_MAX, PASSWORD_MIN, passwordIssues } from "@/lib/password.ts";

/**
 * Email (read-only, so password managers see the username), password and confirmation, with live
 * help. Pasting is allowed; the server applies the same rules.
 */
export function NewPasswordFields({ email }: { email: string }) {
  const t = useTranslations("signup");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const issues = passwordIssues(password, email);
  const typed = password.length > 0;
  const rows: { ok: boolean; text: string }[] = [
    { ok: !issues.includes("short") && typed, text: t("ruleLength", { min: PASSWORD_MIN }) },
    { ok: typed && !issues.some((i) => i === "common" || i === "repetitive"), text: t("ruleCommon") },
    { ok: typed && !issues.includes("email"), text: t("ruleEmail") },
    { ok: typed && password === confirm, text: t("ruleMatch") },
  ];
  return (
    <>
      <label>
        {t("email")}
        <input name="email" type="email" id="email" autoComplete="username" value={email} readOnly />
      </label>
      <label>
        {t("password")}
        <input
          name="password"
          type="password"
          id="new-password"
          autoComplete="new-password"
          minLength={PASSWORD_MIN}
          maxLength={PASSWORD_MAX}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
          autoFocus
        />
      </label>
      <label>
        {t("confirm")}
        <input
          name="confirmPassword"
          type="password"
          id="confirm-password"
          autoComplete="new-password"
          minLength={PASSWORD_MIN}
          maxLength={PASSWORD_MAX}
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          required
        />
      </label>
      <ul className="rules" aria-live="polite">
        {rows.map((row) => (
          <li key={row.text} className={row.ok ? "ok" : undefined}>
            <span aria-hidden="true">{row.ok ? "✓" : "○"}</span> {row.text}
          </li>
        ))}
      </ul>
      <p className="hint">{t("tip")}</p>
    </>
  );
}

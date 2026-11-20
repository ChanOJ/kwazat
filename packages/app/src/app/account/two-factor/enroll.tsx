"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { ResendButton } from "../../resend-button.tsx";
import { enroll, type EnrollState, type Method } from "./actions.ts";

export function Enroll({ current }: { current: Method | null }) {
  const t = useTranslations("twoFactor");
  const [state, action, pending] = useActionState(enroll, { step: "choose" } as EnrollState);

  if (state.step === "done") {
    return (
      <div className="stack-wide">
        <p className="notice">
          {state.method === "totp" ? t("doneTotp") : t("doneEmail")}
        </p>
        {state.backupCodes && (
          <>
            <h2>{t("backupTitle")}</h2>
            <p>{t("backupLead")}</p>
            <ul className="codes">
              {state.backupCodes.map((c) => (
                <li key={c}>
                  <code>{c}</code>
                </li>
              ))}
            </ul>
          </>
        )}
        <p>
          <Link href="/">{t("continue")}</Link>
        </p>
      </div>
    );
  }

  if (state.step === "verify") {
    return (
      <div className="stack-wide">
        {state.method === "totp" ? (
          <>
            <p>{t("scan")}</p>
            {state.qrSvg && <div className="qr" dangerouslySetInnerHTML={{ __html: state.qrSvg }} />}
            <details>
              <summary>{t("cantScan")}</summary>
              <p className="mono">{state.totpURI}</p>
            </details>
          </>
        ) : (
          <p>{t("emailSent")}</p>
        )}
        {state.resent && <p className="notice">{t("sent")}</p>}
        {state.error && (
          <p className="error" role="alert">
            {t(state.error as never, { minutes: state.minutes ?? 1 } as never)}
          </p>
        )}
        <form action={action} className="stack">
          <input type="hidden" name="op" value="confirm" />
          <label>
            {t("code")}
            <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" required autoFocus />
          </label>
          <button type="submit" disabled={pending}>
            {t("confirm")}
          </button>
        </form>
        <form action={action} className="alt-actions">
          {state.method === "email" && (
            <ResendButton key={state.sentAt} namespace="twoFactor" seconds={state.resendIn ?? 0} name="op" value="resend" disabled={pending} />
          )}
          <button type="submit" name="op" value="restart" className="link-button" disabled={pending}>
            {t("another")}
          </button>
        </form>
      </div>
    );
  }

  return (
    <form action={action} className="stack">
      <input type="hidden" name="op" value="start" />
      {state.error && (
        <p className="error" role="alert">
          {t(state.error as never, { minutes: state.minutes ?? 1 } as never)}
        </p>
      )}
      <fieldset className="choices">
        <legend>{t("legend")}</legend>
        <label className="choice">
          <input type="radio" name="method" value="email" defaultChecked={current !== "totp"} />
          <span>
            <strong>{t("emailTitle")}</strong>
            <span className="description">{t("emailDescription")}</span>
          </span>
        </label>
        <label className="choice">
          <input type="radio" name="method" value="totp" defaultChecked={current === "totp"} />
          <span>
            <strong>{t("totpTitle")}</strong>
            <span className="description">{t("totpDescription")}</span>
          </span>
        </label>
      </fieldset>
      <label>
        {t("currentPassword")}
        <input name="password" type="password" autoComplete="current-password" required />
      </label>
      <button type="submit" disabled={pending}>
        {t("start")}
      </button>
    </form>
  );
}

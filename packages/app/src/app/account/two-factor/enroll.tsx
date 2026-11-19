"use client";

import Link from "next/link";
import { useActionState } from "react";
import { enroll, type EnrollState, type Method } from "./actions.ts";

export function Enroll({ current }: { current: Method | null }) {
  const [state, action, pending] = useActionState(enroll, { step: "choose" } as EnrollState);

  if (state.step === "done") {
    return (
      <div className="stack-wide">
        <p className="notice">
          {state.method === "totp" ? "Your authenticator app is now your second factor." : "Codes sent by email are now your second factor."}
        </p>
        {state.backupCodes && (
          <>
            <h2>Backup codes</h2>
            <p>Keep them somewhere safe (a password manager). Each one lets you log in once if you lose your phone. They are not shown again.</p>
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
          <Link href="/">Continue</Link>
        </p>
      </div>
    );
  }

  if (state.step === "verify") {
    return (
      <div className="stack-wide">
        {state.method === "totp" ? (
          <>
            <p>Scan this QR code with your authenticator app (for example Proton Pass, Aegis, 2FAS or your password manager), then enter the 6-digit code it shows.</p>
            {state.qrSvg && <div className="qr" dangerouslySetInnerHTML={{ __html: state.qrSvg }} />}
            <details>
              <summary>Can’t scan it?</summary>
              <p className="mono">{state.totpURI}</p>
            </details>
          </>
        ) : (
          <p>We emailed you a 6-digit code. Enter it here to confirm this address can receive your codes.</p>
        )}
        {state.error && (
          <p className="error" role="alert">
            {state.error}
          </p>
        )}
        <form action={action} className="stack">
          <input type="hidden" name="op" value="confirm" />
          <label>
            Code
            <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" required autoFocus />
          </label>
          <button type="submit" disabled={pending}>
            Confirm
          </button>
        </form>
        <form action={action} className="alt-actions">
          {state.method === "email" && (
            <button type="submit" name="op" value="resend" className="link-button" disabled={pending}>
              Send a new code
            </button>
          )}
          <button type="submit" name="op" value="restart" className="link-button" disabled={pending}>
            Choose another method
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
          {state.error}
        </p>
      )}
      <fieldset className="choices">
        <legend>Second factor</legend>
        <label className="choice">
          <input type="radio" name="method" value="email" defaultChecked={current !== "totp"} />
          <span>
            <strong>Code by email</strong>
            <span className="description">Each login, we email you a 6-digit code and a link that fills it in.</span>
          </span>
        </label>
        <label className="choice">
          <input type="radio" name="method" value="totp" defaultChecked={current === "totp"} />
          <span>
            <strong>Authenticator app</strong>
            <span className="description">A code from an app on your phone or in your password manager. Works offline; comes with backup codes.</span>
          </span>
        </label>
      </fieldset>
      <label>
        Current password
        <input name="password" type="password" autoComplete="current-password" required />
      </label>
      <button type="submit" disabled={pending}>
        Continue
      </button>
    </form>
  );
}

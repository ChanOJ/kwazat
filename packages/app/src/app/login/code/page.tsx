import type { Metadata } from "next";
import { safeNextPath } from "@/lib/access.ts";
import { EMAIL_CODE_MINUTES } from "@/lib/auth.ts";
import { getMethod, resendCode, verifyCode } from "../actions.ts";

export const metadata: Metadata = { title: "Verification code" };

type Params = { next?: string; code?: string; error?: string; sent?: string; backup?: string };

/** Second step of the login: the emailed code (or its link), the app code, or a backup code. */
export default async function CodePage({ searchParams }: { searchParams: Promise<Params> }) {
  const { next: rawNext, code, error, sent, backup } = await searchParams;
  const next = safeNextPath(rawNext);
  const method = await getMethod();
  const useBackup = backup === "1" && method === "totp";
  const prefill = /^\d{6}$/.test(code ?? "") ? code : undefined;

  return (
    <section className="login">
      <h1>{useBackup ? "Backup code" : "Verification code"}</h1>
      <p className="lead">
        {useBackup
          ? "Enter one of the backup codes you saved when you set up your authenticator app. Each works once."
          : method === "totp"
            ? "Enter the 6-digit code shown by your authenticator app."
            : prefill
              ? "Your code is filled in: confirm to log in."
              : `We emailed you a 6-digit code and a link. They expire in ${EMAIL_CODE_MINUTES} minutes.`}
      </p>
      {error && (
        <p className="error" role="alert">
          This code is wrong or has expired.
        </p>
      )}
      {sent && <p className="notice">A new code is on its way.</p>}
      <form action={verifyCode} className="stack">
        <input type="hidden" name="next" value={next} />
        <input type="hidden" name="kind" value={useBackup ? "backup" : "code"} />
        <label>
          {useBackup ? "Backup code" : "Code"}
          <input
            name="code"
            defaultValue={prefill}
            required
            autoFocus
            autoComplete="one-time-code"
            {...(useBackup ? {} : { inputMode: "numeric" as const, pattern: "[0-9 ]{6,7}" })}
          />
        </label>
        <label className="check">
          <input type="checkbox" name="trustDevice" /> Trust this device for 30 days
        </label>
        <button type="submit">Log in</button>
      </form>
      <div className="alt-actions">
        {method === "email" && (
          <form action={resendCode}>
            <input type="hidden" name="next" value={next} />
            <button type="submit" className="link-button">
              Send a new code
            </button>
          </form>
        )}
        {method === "totp" && (
          <a href={`/login/code?${useBackup ? "" : "backup=1&"}next=${encodeURIComponent(next)}`}>
            {useBackup ? "Use the authenticator app" : "Use a backup code"}
          </a>
        )}
        <a href="/login">Start again</a>
      </div>
    </section>
  );
}

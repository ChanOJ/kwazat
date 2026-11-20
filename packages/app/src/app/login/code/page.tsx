import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { safeNextPath } from "@/lib/access.ts";
import { EMAIL_CODE_MINUTES } from "@/lib/auth.ts";
import { waitMinutes } from "@/lib/rate-limit.ts";
import { ResendButton } from "../../resend-button.tsx";
import { getMethod, resendCode, resendWait, verifyCode } from "../actions.ts";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("meta"))("code") };
}

type Params = { next?: string; code?: string; error?: string; sent?: string; backup?: string; wait?: string };

/** Second step of the login: the emailed code (or its link), the app code, or a backup code. */
export default async function CodePage({ searchParams }: { searchParams: Promise<Params> }) {
  const { next: rawNext, code, error, sent, backup, wait: rawWait } = await searchParams;
  const next = safeNextPath(rawNext);
  const method = await getMethod();
  const t = await getTranslations("code");
  const useBackup = backup === "1" && method === "totp";
  const prefill = /^\d{6}$/.test(code ?? "") ? code : undefined;
  // A refused attempt says how long to wait; otherwise the countdown follows the last code sent.
  const wait = Math.min(Number(rawWait) || 0, 3600);
  const resendIn = Math.max(error === "rate" ? 0 : wait, await resendWait());

  return (
    <section className="login">
      <h1>{useBackup ? t("titleBackup") : t("titleCode")}</h1>
      <p className="lead">
        {useBackup
          ? t("leadBackup")
          : method === "totp"
            ? t("leadTotp")
            : prefill
              ? t("leadPrefilled")
              : t("leadEmail", { minutes: EMAIL_CODE_MINUTES })}
      </p>
      {(error || wait > 0) && (
        <p className="error" role="alert">
          {wait > 0 ? t("tooMany", { minutes: waitMinutes(wait) }) : t("error")}
        </p>
      )}
      {sent && !wait && <p className="notice">{t("sent")}</p>}
      <form action={verifyCode} className="stack">
        <input type="hidden" name="next" value={next} />
        <input type="hidden" name="kind" value={useBackup ? "backup" : "code"} />
        <label>
          {useBackup ? t("labelBackup") : t("labelCode")}
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
          <input type="checkbox" name="trustDevice" /> {t("trust")}
        </label>
        <button type="submit">{t("submit")}</button>
      </form>
      <div className="alt-actions">
        {method === "email" && (
          <form action={resendCode}>
            <input type="hidden" name="next" value={next} />
            <ResendButton namespace="code" seconds={resendIn} />
          </form>
        )}
        {method === "totp" && (
          <a href={`/login/code?${useBackup ? "" : "backup=1&"}next=${encodeURIComponent(next)}`}>
            {useBackup ? t("useApp") : t("useBackup")}
          </a>
        )}
        <a href="/login">{t("restart")}</a>
      </div>
    </section>
  );
}

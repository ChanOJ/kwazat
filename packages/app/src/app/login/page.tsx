import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { ENROLL_PATH, safeNextPath } from "@/lib/access.ts";
import { getLoginEmail } from "@/lib/login-email.ts";
import { getViewer } from "@/lib/viewer.ts";
import { startLogin } from "./actions.ts";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("meta"))("login") };
}

/** First screen: the email address only, then "Log in" or "Create account". */
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string; expired?: string }> }) {
  const { next, error, expired } = await searchParams;
  const viewer = await getViewer();
  if (viewer) redirect(viewer.twoFactorEnabled ? safeNextPath(next) : ENROLL_PATH);
  const t = await getTranslations("login");
  const previous = await getLoginEmail();
  return (
    <section className="login">
      <h1>{t("title")}</h1>
      <p className="lead">{t("lead")}</p>
      {error === "email" && (
        <p className="error" role="alert">
          {t("badEmail")}
        </p>
      )}
      {expired && (
        <p className="error" role="alert">
          {t("expired")}
        </p>
      )}
      <form action={startLogin} className="stack">
        <input type="hidden" name="next" value={safeNextPath(next)} />
        <label>
          {t("email")}
          <input name="email" type="email" id="email" autoComplete="username" inputMode="email" defaultValue={previous ?? ""} required autoFocus />
        </label>
        <div className="actions">
          <button type="submit" name="intent" value="login">
            {t("submit")}
          </button>
          <button type="submit" name="intent" value="signup" className="secondary">
            {t("createAccount")}
          </button>
        </div>
      </form>
    </section>
  );
}

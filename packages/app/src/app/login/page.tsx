import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { ENROLL_PATH, safeNextPath } from "@/lib/access.ts";
import { getLoginEmail } from "@/lib/login-email.ts";
import { getViewer } from "@/lib/viewer.ts";
import { logIn, startSignup } from "./actions.ts";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("meta"))("login") };
}

/** Login: address and password, then the second factor. Signup is its own page. */
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
      {error && (
        <p className="error" role="alert">
          {error === "email" ? t("badEmail") : t("error")}
        </p>
      )}
      {expired && (
        <p className="error" role="alert">
          {t("expired")}
        </p>
      )}
      <form action={logIn} className="stack">
        <input type="hidden" name="next" value={safeNextPath(next)} />
        <label>
          {t("email")}
          <input name="email" type="email" id="email" autoComplete="username" inputMode="email" defaultValue={previous ?? ""} required autoFocus />
        </label>
        <label>
          {t("password")}
          <input name="password" type="password" id="password" autoComplete="current-password" required />
        </label>
        <div className="actions">
          <button type="submit">{t("submit")}</button>
          <button type="submit" formAction={startSignup} formNoValidate className="secondary">
            {t("createAccount")}
          </button>
        </div>
      </form>
    </section>
  );
}

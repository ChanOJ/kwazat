import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { ENROLL_PATH, safeNextPath } from "@/lib/access.ts";
import { getLoginEmail } from "@/lib/login-email.ts";
import { getViewer } from "@/lib/viewer.ts";
import { logIn } from "../actions.ts";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("meta"))("login") };
}

/** Second screen of the login: the password. */
export default async function LoginPasswordPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next: rawNext, error } = await searchParams;
  const next = safeNextPath(rawNext);
  const viewer = await getViewer();
  if (viewer) redirect(viewer.twoFactorEnabled ? next : ENROLL_PATH);
  const email = await getLoginEmail();
  if (!email) redirect("/login");
  const t = await getTranslations("login");
  return (
    <section className="login">
      <h1>{t("passwordTitle")}</h1>
      {error && (
        <p className="error" role="alert">
          {t("error")}
        </p>
      )}
      <form action={logIn} className="stack">
        <input type="hidden" name="next" value={next} />
        {/* Read-only, but a real username field: password managers match the login on it. */}
        <label>
          {t("email")}
          <input name="email" type="email" id="email" autoComplete="username" value={email} readOnly />
        </label>
        <label>
          {t("password")}
          <input name="password" type="password" id="password" autoComplete="current-password" required autoFocus />
        </label>
        <div className="actions">
          <button type="submit">{t("submit")}</button>
          <Link href={next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`}>{t("otherAddress")}</Link>
        </div>
      </form>
    </section>
  );
}

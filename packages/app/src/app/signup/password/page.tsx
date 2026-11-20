import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { ENROLL_PATH, safeNextPath } from "@/lib/access.ts";
import { getLoginEmail } from "@/lib/login-email.ts";
import { getViewer } from "@/lib/viewer.ts";
import { signUp } from "../actions.ts";
import { NewPasswordFields } from "./new-password-fields.tsx";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("meta"))("signup") };
}

/** Second screen of the signup: the password, twice. */
export default async function SignupPasswordPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next: rawNext, error } = await searchParams;
  const next = safeNextPath(rawNext);
  const viewer = await getViewer();
  if (viewer) redirect(viewer.twoFactorEnabled ? next : ENROLL_PATH);
  const email = await getLoginEmail();
  if (!email) redirect("/login");
  const t = await getTranslations("signup");
  const back = next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`;
  return (
    <section className="login">
      <h1>{t("title")}</h1>
      <p className="lead">{t("lead")}</p>
      {error && ["differ", "weak", "exists", "rate"].includes(error) && (
        <p className="error" role="alert">
          {t(`error.${error}` as never)}
          {error === "exists" && (
            <>
              {" "}
              <Link href="/login/password">{t("logInInstead")}</Link>
            </>
          )}
        </p>
      )}
      <form action={signUp} className="stack">
        <input type="hidden" name="next" value={next} />
        <NewPasswordFields email={email} />
        <div className="actions">
          <button type="submit">{t("submit")}</button>
          <Link href={back}>{t("otherAddress")}</Link>
        </div>
      </form>
    </section>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { ENROLL_PATH, safeNextPath } from "@/lib/access.ts";
import { getLoginEmail } from "@/lib/login-email.ts";
import { getPrefill } from "@/lib/signup-secret.ts";
import { getViewer } from "@/lib/viewer.ts";
import { signUp } from "./actions.ts";
import { NewPasswordFields } from "./new-password-fields.tsx";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("meta"))("signup") };
}

/** Signup: address, password twice (live help), then the second factor. */
export default async function SignupPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next: rawNext, error } = await searchParams;
  const next = safeNextPath(rawNext);
  const viewer = await getViewer();
  if (viewer) redirect(viewer.twoFactorEnabled ? next : ENROLL_PATH);
  const email = await getLoginEmail();
  const prefilled = email ? await getPrefill(email) : "";
  const t = await getTranslations("signup");
  const back = next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`;
  return (
    <section className="login">
      <h1>{t("title")}</h1>
      <p className="lead">{t("lead")}</p>
      {error && ["email", "differ", "weak", "exists", "rate"].includes(error) && (
        <p className="error" role="alert">
          {t(`error.${error}` as never)}
          {error === "exists" && (
            <>
              {" "}
              <Link href="/login">{t("logInInstead")}</Link>
            </>
          )}
        </p>
      )}
      <form action={signUp} className="stack">
        <input type="hidden" name="next" value={next} />
        <NewPasswordFields initialEmail={email ?? ""} initialPassword={prefilled} />
        <div className="actions">
          <button type="submit">{t("submit")}</button>
          <Link href={back}>{t("haveAccount")}</Link>
        </div>
      </form>
    </section>
  );
}

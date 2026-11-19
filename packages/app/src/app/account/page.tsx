import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { LOCALES } from "@/i18n/locales.ts";
import { getViewer } from "@/lib/viewer.ts";
import { setLocale } from "../locale-actions.ts";
import { BackupCodesForm, EmailForm, PasswordForm } from "./forms.tsx";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("meta"))("account") };
}

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ email?: string }> }) {
  const viewer = (await getViewer())!; // the proxy only lets logged-in users here
  const { email } = await searchParams;
  const [t, tl] = await Promise.all([getTranslations("account"), getTranslations("languages")]);
  return (
    <section className="account">
      <h1>{t("title")}</h1>
      <p className="lead">{t("lead")}</p>
      {email === "step" && <p className="notice">{t("emailStep")}</p>}

      <section className="panel">
        <h2>{t("emailTitle")}</h2>
        <p>{t.rich("currentAddress", { email: viewer.email, b: (chunks) => <strong>{chunks}</strong> })}</p>
        <EmailForm current={viewer.email} />
      </section>

      <section className="panel">
        <h2>{t("passwordTitle")}</h2>
        <PasswordForm />
      </section>

      <section className="panel">
        <h2>{t("twoFactorTitle")}</h2>
        <p>
          {viewer.twoFactorMethod === "totp" ? t("twoFactorTotp") : t("twoFactorEmail")} <Link href="/account/two-factor">{t("change")}</Link>
        </p>
        {viewer.twoFactorMethod === "totp" && (
          <details>
            <summary>{t("replaceBackup")}</summary>
            <BackupCodesForm />
          </details>
        )}
      </section>

      <section className="panel">
        <h2>{t("languageTitle")}</h2>
        <p>{t("languageLead")}</p>
        {/* Keyed: React resets a form after its action; remounting shows the saved choice. */}
        <form action={setLocale} className="stack" key={viewer.locale ?? "auto"}>
          <label>
            {t("languageTitle")}
            <select name="locale" defaultValue={viewer.locale ?? "auto"}>
              <option value="auto">{t("languageAuto")}</option>
              {LOCALES.map((locale) => (
                <option key={locale} value={locale} lang={locale}>
                  {tl(locale)}
                </option>
              ))}
            </select>
          </label>
          <button type="submit">{t("languageSave")}</button>
        </form>
      </section>
    </section>
  );
}

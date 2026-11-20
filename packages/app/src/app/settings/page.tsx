import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { cookies } from "next/headers";
import { LOCALES } from "@/i18n/locales.ts";
import { parseTheme, THEME_COOKIE } from "@/lib/theme.ts";
import { getViewer } from "@/lib/viewer.ts";
import { LanguagePicker } from "../language-picker.tsx";
import { setLocale } from "../locale-actions.ts";
import { setTheme } from "../theme-actions.ts";
import { ThemeChoices } from "../theme-picker.tsx";
import { BackupCodesForm, EmailForm, PasswordForm } from "./forms.tsx";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("meta"))("settings") };
}

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ email?: string }> }) {
  const viewer = (await getViewer())!; // the proxy only lets logged-in users here
  const { email } = await searchParams;
  const [t, tl, tp, tt, cookieStore] = await Promise.all([
    getTranslations("account"),
    getTranslations("languages"),
    getTranslations("profile"),
    getTranslations("themes"),
    cookies(),
  ]);
  const theme = parseTheme(cookieStore.get(THEME_COOKIE)?.value);
  const current = viewer.locale ?? "auto";
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
          {viewer.twoFactorMethod === "totp" ? t("twoFactorTotp") : t("twoFactorEmail")} <Link href="/settings/two-factor">{t("change")}</Link>
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
        <LanguagePicker
          action={setLocale}
          options={LOCALES.map((code) => ({ code, name: tl(code) }))}
          current={current}
          auto={t("languageAuto")}
          className="button-link"
          labels={{ title: tp("chooseLanguage"), search: tp("searchLanguages"), close: tp("close") }}
        >
          {current === "auto" ? t("languageAuto") : tl(current as "en" | "fr")} · {t("languageChange")}
        </LanguagePicker>
      </section>

      <section className="panel">
        <h2>{t("themeTitle")}</h2>
        <p>{t("themeLead")}</p>
        <ThemeChoices action={setTheme} current={theme} names={{ dark: tt("dark"), light: tt("light"), device: tt("device") }} />
      </section>

      <section className="panel">
        <h2>{t("redLinesTitle")}</h2>
        <p>{t("redLinesLead")}</p>
        <p>
          <Link href="/red-lines">{t("redLinesLink")}</Link>
        </p>
      </section>
    </section>
  );
}

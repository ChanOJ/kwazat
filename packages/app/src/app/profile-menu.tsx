import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { LOCALES } from "@/i18n/locales.ts";
import { signOut } from "./actions.ts";
import { setLocale } from "./locale-actions.ts";
import { ProfileClose } from "./profile-close.tsx";

const silhouette = (
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8">
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" strokeLinecap="round" />
  </svg>
);

/** Profile icon in the top corner; its menu opens without JavaScript (details/summary). */
export async function ProfileMenu({ email }: { email: string }) {
  const t = await getTranslations("profile");
  return (
    <details className="profile">
      <ProfileClose />
      <summary aria-label={t("menu")}>{silhouette}</summary>
      <div className="profile-menu" role="menu">
        <p className="profile-email">{email}</p>
        <Link href="/account" role="menuitem">
          {t("account")}
        </Link>
        <Link href="/red-lines" role="menuitem">
          {t("redLines")}
        </Link>
        <form action={signOut}>
          <button type="submit" className="link-button" role="menuitem">
            {t("logOut")}
          </button>
        </form>
      </div>
    </details>
  );
}

/**
 * Logged out: the same silhouette, dimmed and dashed, with an incognito badge (hat and glasses).
 * Its menu leads to login and lets anyone pick the language (kept in a cookie).
 */
export async function AnonymousProfile() {
  const [t, tl, current] = await Promise.all([getTranslations("profile"), getTranslations("languages"), getLocale()]);
  return (
    <details className="profile">
      <ProfileClose />
      <summary aria-label={`${t("anonymous")} · ${t("menu")}`} title={t("anonymous")} className="anonymous">
        {silhouette}
        <span className="profile-badge" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
            <path d="M8 3.5h8l1.6 6H6.4z" />
            <rect x="3" y="10" width="18" height="1.8" rx=".9" />
            <circle cx="7.5" cy="16.5" r="3" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <circle cx="16.5" cy="16.5" r="3" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path d="M10.5 16.2q1.5-1 3 0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </span>
      </summary>
      <div className="profile-menu" role="menu">
        <p className="profile-email">{t("anonymous")}</p>
        <Link href="/login" role="menuitem">
          {t("logIn")}
        </Link>
        <p className="profile-heading">{t("language")}</p>
        <form action={setLocale} className="profile-languages">
          {LOCALES.map((locale) => (
            <button key={locale} type="submit" name="locale" value={locale} role="menuitemradio" aria-checked={locale === current} lang={locale}>
              {tl(locale)}
            </button>
          ))}
        </form>
      </div>
    </details>
  );
}

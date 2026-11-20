import Link from "next/link";
import type { ReactNode } from "react";
import { getLocale, getTranslations } from "next-intl/server";
import { LOCALES } from "@/i18n/locales.ts";
import { signOut } from "./actions.ts";
import { HideInLogin } from "./hide-in-login.tsx";
import { LanguagePicker } from "./language-picker.tsx";
import { setLocale } from "./locale-actions.ts";
import { ProfileClose } from "./profile-close.tsx";

const silhouette = (
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8">
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" strokeLinecap="round" />
  </svg>
);

/** Line icons for the menu rows (20px, current color). */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg className="menu-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}
const icons = {
  redLines: (
    <Icon>
      <path d="M5 21V4" />
      <path d="M5 4h12l-2.5 4L17 12H5" />
    </Icon>
  ),
  feedback: (
    <Icon>
      <path d="M4 9v6h3l8 4V5L7 9z" />
      <path d="M19 9.5a3.5 3.5 0 0 1 0 5" />
    </Icon>
  ),
  help: (
    <Icon>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7" />
      <path d="M12 17h.01" />
    </Icon>
  ),
  language: (
    <Icon>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z" />
    </Icon>
  ),
  settings: (
    <Icon>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1" />
    </Icon>
  ),
  logIn: (
    <Icon>
      <path d="M14 4h5v16h-5" />
      <path d="M4 12h11M11 8l4 4-4 4" />
    </Icon>
  ),
  logOut: (
    <Icon>
      <path d="M10 4H5v16h5" />
      <path d="M9 12h11M16 8l4 4-4 4" />
    </Icon>
  ),
};

/** Red lines, Feedback and Get help: the same for everyone. */
async function CommonLinks() {
  const t = await getTranslations("profile");
  return (
    <>
      <Link href="/red-lines" role="menuitem">
        {icons.redLines}
        {t("redLines")}
      </Link>
      <Link href="/feedback" role="menuitem">
        {icons.feedback}
        {t("feedback")}
      </Link>
      <Link href="/help" role="menuitem">
        {icons.help}
        {t("help")}
      </Link>
    </>
  );
}

/** Profile icon in the top corner; its menu opens without JavaScript (details/summary). */
export async function ProfileMenu({ email }: { email: string }) {
  const t = await getTranslations("profile");
  return (
    <details className="profile">
      <ProfileClose />
      <summary aria-label={t("menu")}>{silhouette}</summary>
      <div className="profile-menu" role="menu">
        <p className="profile-email">{email}</p>
        <CommonLinks />
        <Link href="/settings" role="menuitem">
          {icons.settings}
          {t("settings")}
        </Link>
        <hr />
        <form action={signOut}>
          <button type="submit" role="menuitem">
            {icons.logOut}
            {t("logOut")}
          </button>
        </form>
      </div>
    </details>
  );
}

/**
 * Logged out: the same silhouette, dimmed and dashed, with an incognito badge (hat and glasses).
 * Its menu lets anyone read the common pages and pick the language (kept in a cookie); inside the
 * login funnel it only offers the language.
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
        <HideInLogin>
          <Link href="/login" role="menuitem">
            {icons.logIn}
            {t("logIn")}
          </Link>
          <hr />
          <CommonLinks />
        </HideInLogin>
        <LanguagePicker
          action={setLocale}
          options={LOCALES.map((code) => ({ code, name: tl(code) }))}
          current={current}
          role="menuitem"
          labels={{ title: t("chooseLanguage"), search: t("searchLanguages"), close: t("close") }}
        >
          {icons.language}
          {t("language")}
        </LanguagePicker>
      </div>
    </details>
  );
}

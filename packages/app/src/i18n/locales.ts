/** Interface languages. English is the reference: every message exists in it first. */
export const LOCALES = ["en", "fr"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

/** Language chosen without an account (anonymous profile menu), one year. */
export const LOCALE_COOKIE = "kwazat_locale";

export const isLocale = (value: unknown): value is Locale => LOCALES.includes(value as Locale);

/** Best supported language of an Accept-Language header, by quality then order. */
export function negotiate(acceptLanguage: string | null | undefined): Locale {
  const ranked = (acceptLanguage ?? "")
    .split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = Number(params.find((p) => p.trim().startsWith("q="))?.trim().slice(2) ?? 1);
      return { base: tag.toLowerCase().split("-")[0], q: Number.isFinite(q) ? q : 0, index };
    })
    .filter((l) => l.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  return ranked.map((l) => l.base).find(isLocale) ?? DEFAULT_LOCALE;
}

/**
 * The interface language: the account's choice, else the cookie (chosen while logged out), else
 * the browser's language.
 */
export function resolveLocale(input: { account?: string | null; cookie?: string | null; acceptLanguage?: string | null }): Locale {
  if (isLocale(input.account)) return input.account;
  if (isLocale(input.cookie)) return input.cookie;
  return negotiate(input.acceptLanguage);
}

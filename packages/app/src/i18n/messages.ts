import { createTranslator } from "next-intl";
import en from "../../messages/en.json";
import fr from "../../messages/fr.json";
import type { Locale } from "./locales.ts";

export const MESSAGES = { en, fr } satisfies Record<Locale, typeof en>;

/** Translator usable outside a request (emails sent by Better Auth, scripts). */
export function translator<N extends keyof typeof en>(locale: Locale, namespace: N) {
  return createTranslator({ locale, messages: MESSAGES[locale], namespace });
}

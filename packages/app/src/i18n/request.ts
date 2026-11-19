import { getRequestConfig } from "next-intl/server";
import { cookies, headers } from "next/headers";
import { getViewer } from "@/lib/viewer.ts";
import { LOCALE_COOKIE, resolveLocale } from "./locales.ts";
import { MESSAGES } from "./messages.ts";

export default getRequestConfig(async () => {
  const [viewer, cookieStore, requestHeaders] = await Promise.all([getViewer(), cookies(), headers()]);
  const locale = resolveLocale({
    account: viewer?.locale,
    cookie: cookieStore.get(LOCALE_COOKIE)?.value,
    acceptLanguage: requestHeaders.get("accept-language"),
  });
  return { locale, messages: MESSAGES[locale] };
});

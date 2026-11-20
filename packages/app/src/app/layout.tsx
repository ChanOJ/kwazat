import type { Metadata } from "next";
import Link from "next/link";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { parseTheme, THEME_COOKIE } from "@/lib/theme.ts";
import { getViewer } from "@/lib/viewer.ts";
import { AnonymousProfile, ProfileMenu } from "./profile-menu.tsx";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("meta");
  return {
    title: { default: "Kwazat", template: "%s · Kwazat" },
    description: t("description"),
    robots: { index: false, follow: false },
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [viewer, locale, cookieStore] = await Promise.all([getViewer(), getLocale(), cookies()]);
  const theme = parseTheme(cookieStore.get(THEME_COOKIE)?.value);
  return (
    <html lang={locale} data-theme={theme === "device" ? undefined : theme}>
      <body>
        <NextIntlClientProvider>
          <header className="site-header">
            <Link href="/" className="brand">
              Kwazat
            </Link>
            {viewer ? <ProfileMenu email={viewer.email} /> : <AnonymousProfile />}
          </header>
          <main>{children}</main>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
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
  const [viewer, locale] = await Promise.all([getViewer(), getLocale()]);
  return (
    <html lang={locale}>
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

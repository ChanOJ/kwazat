import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { getViewer } from "@/lib/viewer.ts";
import { AnonymousProfile, ProfileMenu } from "./profile-menu.tsx";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Kwazat", template: "%s · Kwazat" },
  description: "Neutral, sourced fact sheets on public figures, brands and products.",
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const viewer = await getViewer();
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <Link href="/" className="brand">
            Kwazat
          </Link>
          {viewer ? <ProfileMenu email={viewer.email} /> : <AnonymousProfile />}
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}

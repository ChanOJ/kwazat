import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { getViewer } from "@/lib/viewer.ts";
import { signOut } from "./actions.ts";
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
          {viewer && (
            <form action={signOut} className="session">
              <span className="who">{viewer.name}</span>
              <button type="submit" className="link-button">
                Log out
              </button>
            </form>
          )}
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}

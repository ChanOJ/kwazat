import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { storedRedLines } from "@/lib/red-lines.ts";
import { getViewer } from "@/lib/viewer.ts";
import { RedLinesEditor } from "./editor.tsx";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("meta"))("redLines") };
}

export default async function RedLinesSettingsPage() {
  const viewer = (await getViewer())!; // the proxy only lets logged-in users here
  const [t, stored] = await Promise.all([getTranslations("redLinesSettings"), storedRedLines(viewer.id)]);
  return (
    <section className="account">
      <p>
        <Link href="/settings">{t("back")}</Link>
      </p>
      <h1>{t("title")}</h1>
      <p className="lead">{t("lead")}</p>
      <RedLinesEditor userId={viewer.id} stored={stored} />
    </section>
  );
}

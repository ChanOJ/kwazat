import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("meta"))("redLines") };
}

export default async function RedLinesPage() {
  const t = await getTranslations("redLines");
  return (
    <section>
      <h1>{t("title")}</h1>
      <p className="lead">{t("lead")}</p>
      <p className="notice">{t("soon")}</p>
    </section>
  );
}

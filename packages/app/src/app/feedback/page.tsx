import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("meta"))("feedback") };
}

export default async function FeedbackPage() {
  const t = await getTranslations("feedback");
  return (
    <section>
      <h1>{t("title")}</h1>
      <p className="notice">{t("soon")}</p>
    </section>
  );
}

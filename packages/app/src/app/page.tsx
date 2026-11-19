import { getTranslations } from "next-intl/server";
import { SearchForm } from "./search-form.tsx";

export default async function Home() {
  const t = await getTranslations("home");
  return (
    <section className="home">
      <h1>{t("title")}</h1>
      <p className="lead">{t("lead")}</p>
      <SearchForm />
    </section>
  );
}

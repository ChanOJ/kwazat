import { getTranslations } from "next-intl/server";

export async function SearchForm({ query = "" }: { query?: string }) {
  const t = await getTranslations("search");
  return (
    <form action="/search" method="get" role="search" className="search-form">
      <label htmlFor="q" className="visually-hidden">
        {t("label")}
      </label>
      <input id="q" name="q" type="search" defaultValue={query} placeholder={t("placeholder")} autoComplete="off" required />
      <button type="submit">{t("button")}</button>
    </form>
  );
}

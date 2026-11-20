import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { entityIdentifiers, and, eq, inArray } from "@kwazat/db";
import { searchKnownEntities, wikidataCandidates } from "@kwazat/researcher/names";
import { getDb } from "@/lib/db.ts";
import { startResearch } from "../research/actions.ts";
import { SearchForm } from "../search-form.tsx";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("meta"))("search") };
}

/**
 * Name search, as `pnpm lookup` does it: entities Kwazat already knows, then Wikidata
 * candidates (cached 24 h). People and music groups.
 */
export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const raw = (await searchParams).q;
  const query = (Array.isArray(raw) ? raw[0] : raw)?.trim().slice(0, 200) ?? "";
  if (!query) return <SearchForm />;

  const t = await getTranslations("search");
  const db = await getDb();
  const [known, candidates] = await Promise.all([
    searchKnownEntities(db, query),
    wikidataCandidates(db, query, { kinds: ["person", "band"] }).catch(() => null),
  ]);
  // Wikidata candidates Kwazat already has a sheet for link to it instead of starting research.
  const ids = candidates?.map((c) => c.wikidataId) ?? [];
  const knownByWikidata = new Map(
    ids.length
      ? (
          await db
            .select({ value: entityIdentifiers.value, entityId: entityIdentifiers.entityId })
            .from(entityIdentifiers)
            .where(and(eq(entityIdentifiers.scheme, "wikidata"), inArray(entityIdentifiers.value, ids)))
        ).map((r) => [r.value, r.entityId])
      : [],
  );
  const shownAbove = new Set(known.map((k) => k.entityId));
  const others = candidates?.filter((c) => !shownAbove.has(knownByWikidata.get(c.wikidataId) ?? "")) ?? null;

  return (
    <section>
      <SearchForm query={query} />
      <h2>{t("known")}</h2>
      {known.length === 0 ? (
        <p className="empty">{t("noSheet", { query })}</p>
      ) : (
        <ul className="results">
          {known.map((k) => (
            <li key={k.entityId}>
              <Link href={`/entity/${k.entityId}`} className="result-link">
                <span className="label">{k.label}</span>
                {k.type === "band" && <span className="kind">{t("kind.band")}</span>}
                {k.description && <span className="description">{k.description}</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <h2>{t("others")}</h2>
      {others === null ? (
        <p className="empty">{t("wikidataDown")}</p>
      ) : others.length === 0 ? (
        <p className="empty">{t("noOther")}</p>
      ) : (
        <ul className="results">
          {others.map((c) => (
            <li key={c.wikidataId}>
              {knownByWikidata.has(c.wikidataId) ? (
                <Link href={`/entity/${knownByWikidata.get(c.wikidataId)}`} className="result-link">
                  <span className="label">{c.label}</span>
                  {c.kind === "band" && <span className="kind">{t("kind.band")}</span>}
                  {c.description && <span className="description">{c.description}</span>}
                </Link>
              ) : (
                // A button, not a link: research is paid and must never start from a prefetch.
                <form action={startResearch} className="result-research">
                  <input type="hidden" name="wikidataId" value={c.wikidataId} />
                  <input type="hidden" name="type" value={c.kind ?? "person"} />
                  <button type="submit" className="result-button">
                    <span className="label">{c.label}</span>
                    {c.kind === "band" && <span className="kind">{t("kind.band")}</span>}
                    {c.description && <span className="description">{c.description}</span>}
                    <span className="id">{t("notYet")}</span>
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

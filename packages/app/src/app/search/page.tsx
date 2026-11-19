import type { Metadata } from "next";
import Link from "next/link";
import { entityIdentifiers, and, eq, inArray } from "@kwazat/db";
import { searchKnownEntities, wikidataCandidates } from "@kwazat/researcher/names";
import { getDb } from "@/lib/db.ts";
import { startResearch } from "../research/actions.ts";
import { SearchForm } from "../search-form.tsx";

export const metadata: Metadata = { title: "Search" };

/**
 * Name search, as `pnpm lookup` does it: entities Kwazat already knows, then Wikidata
 * candidates (cached 24 h). Only people for now, like the researcher.
 */
export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const raw = (await searchParams).q;
  const query = (Array.isArray(raw) ? raw[0] : raw)?.trim().slice(0, 200) ?? "";
  if (!query) return <SearchForm />;

  const db = await getDb();
  const [known, candidates] = await Promise.all([
    searchKnownEntities(db, query),
    wikidataCandidates(db, query, { humansOnly: true }).catch(() => null),
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
      <h2>Known to Kwazat</h2>
      {known.length === 0 ? (
        <p className="empty">No sheet yet for “{query}”.</p>
      ) : (
        <ul className="results">
          {known.map((k) => (
            <li key={k.entityId}>
              <Link href={`/entity/${k.entityId}`} className="result-link">
                <span className="label">{k.label}</span>
                {k.description && <span className="description">{k.description}</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <h2>Other matches on Wikidata</h2>
      {others === null ? (
        <p className="empty">Wikidata could not be reached. Try again in a moment.</p>
      ) : others.length === 0 ? (
        <p className="empty">No other match.</p>
      ) : (
        <ul className="results">
          {others.map((c) => (
            <li key={c.wikidataId}>
              {knownByWikidata.has(c.wikidataId) ? (
                <Link href={`/entity/${knownByWikidata.get(c.wikidataId)}`} className="result-link">
                  <span className="label">{c.label}</span>
                  {c.description && <span className="description">{c.description}</span>}
                </Link>
              ) : (
                // A button, not a link: research is paid and must never start from a prefetch.
                <form action={startResearch} className="result-research">
                  <input type="hidden" name="wikidataId" value={c.wikidataId} />
                  <button type="submit" className="result-button">
                    <span className="label">{c.label}</span>
                    {c.description && <span className="description">{c.description}</span>}
                    <span className="id">Not in Kwazat yet · research this person</span>
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

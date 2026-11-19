import type { Metadata } from "next";
import { searchKnownEntities, wikidataCandidates } from "@kwazat/researcher/names";
import { getDb } from "@/lib/db.ts";
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
              <span className="label">{k.label}</span>
              {k.description && <span className="description">{k.description}</span>}
            </li>
          ))}
        </ul>
      )}
      <h2>On Wikidata</h2>
      {candidates === null ? (
        <p className="empty">Wikidata could not be reached. Try again in a moment.</p>
      ) : candidates.length === 0 ? (
        <p className="empty">No match.</p>
      ) : (
        <ul className="results">
          {candidates.map((c) => (
            <li key={c.wikidataId}>
              <span className="label">{c.label}</span>
              {c.description && <span className="description">{c.description}</span>}
              <span className="id">{c.wikidataId}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Name search with three levels, so that popular searches never reach Wikidata again:
 *   1. known entities in our database (trigram search on normalized names and aliases), for
 *      instant suggestions;
 *   2. cached Wikidata candidate lists per normalized query (CACHE_TTL_HOURS);
 *   3. Wikidata itself, with identical concurrent queries coalesced into one request and a
 *      global throttle (see wikidata.ts).
 * Resolution (choosing the entity a sheet is about) always uses the full candidate list of
 * levels 2-3: our own database only knows the entities already researched, and showing only
 * those would hide homonyms.
 */
import {
  and,
  eq,
  entities,
  entityIdentifiers,
  entityNames,
  isNull,
  normalizeName,
  sql,
  wikidataSearchCache,
  type Db,
} from "@kwazat/db";
import { searchCandidates, type Candidate, type EntityKind } from "./wikidata.ts";

const CACHE_TTL_HOURS = 24;
/** Part of the cache key: bump it when the candidate search changes, to ignore older lists. */
const SEARCH_VERSION = 4;

const inFlight = new Map<string, Promise<Candidate[]>>();

/** Wikidata candidates for a query, from the cache when fresh. */
export async function wikidataCandidates(db: Db, query: string, opts: { kinds: EntityKind[] }): Promise<Candidate[]> {
  const normalized = normalizeName(query);
  if (!normalized) return [];
  // The wanted kinds are part of the cache key (stored in the language column, no schema change).
  const lang = `en:v${SEARCH_VERSION}:${[...opts.kinds].sort().join("+")}`;
  const key = `${lang}|${normalized}`;

  const [cached] = await db
    .select()
    .from(wikidataSearchCache)
    .where(
      and(
        eq(wikidataSearchCache.query, normalized),
        eq(wikidataSearchCache.lang, lang),
        eq(wikidataSearchCache.humansOnly, false),
      ),
    );
  if (cached && Date.now() - cached.fetchedAt.getTime() < CACHE_TTL_HOURS * 3_600_000) {
    return cached.results as Candidate[];
  }

  // Coalesce identical concurrent queries into a single Wikidata request.
  let pending = inFlight.get(key);
  if (!pending) {
    pending = (async () => {
      try {
        const results = await searchCandidates(query, opts);
        const values = { query: normalized, lang, humansOnly: false, results, fetchedAt: new Date() };
        await db
          .insert(wikidataSearchCache)
          .values(values)
          .onConflictDoUpdate({
            target: [wikidataSearchCache.query, wikidataSearchCache.lang, wikidataSearchCache.humansOnly],
            set: { results, fetchedAt: values.fetchedAt },
          });
        return results;
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, pending);
  }
  return pending;
}

export type KnownMatch = { entityId: string; type: string; label: string; description: string | null; score: number };

/** Entities already in our database whose name or alias resembles the query (instant suggestions). */
export async function searchKnownEntities(db: Db, query: string, limit = 10): Promise<KnownMatch[]> {
  const normalized = normalizeName(query);
  if (normalized.length < 3) return [];
  const score = sql<number>`max(similarity(${entityNames.normalized}, ${normalized}))`;
  const rows = await db
    .select({
      entityId: entities.id,
      type: entities.type,
      label: entities.label,
      description: entities.description,
      score,
    })
    .from(entityNames)
    .innerJoin(entities, eq(entities.id, entityNames.entityId))
    .where(and(isNull(entities.mergedInto), sql`${entityNames.normalized} % ${normalized}`))
    .groupBy(entities.id)
    // Ties (same normalized name) in creation order: ids are UUIDv7, so results stay stable.
    .orderBy(sql`${score} desc`, entities.id)
    .limit(limit);
  return rows.map((r) => ({ ...r, score: Number(r.score) }));
}

/** Replaces the searchable names of an entity (label + aliases), normalized and deduplicated. */
export async function setEntityNames(
  db: Pick<Db, "delete" | "insert">,
  entityId: string,
  names: { name: string; lang: string | null }[],
) {
  const unique = new Map<string, { name: string; lang: string | null }>();
  for (const n of names) {
    const normalized = normalizeName(n.name);
    if (normalized && !unique.has(normalized)) unique.set(normalized, n);
  }
  await db.delete(entityNames).where(eq(entityNames.entityId, entityId));
  if (unique.size) {
    await db.insert(entityNames).values([...unique].map(([normalized, n]) => ({ entityId, normalized, ...n })));
  }
}

/** Entity for an external identifier, following merge redirects. */
export async function findEntityByIdentifier(db: Db, scheme: string, value: string) {
  const [row] = await db
    .select({ entityId: entityIdentifiers.entityId })
    .from(entityIdentifiers)
    .where(and(eq(entityIdentifiers.scheme, scheme as never), eq(entityIdentifiers.value, value)));
  return row ? findEntity(db, row.entityId) : undefined;
}

/** Entity by Kwazat id, following merge redirects (at most a few hops). */
export async function findEntity(db: Db, id: string) {
  let current = id;
  for (let hop = 0; hop < 5; hop++) {
    const [entity] = await db.select().from(entities).where(eq(entities.id, current));
    if (!entity?.mergedInto) return entity;
    current = entity.mergedInto;
  }
  throw new Error(`Too many merge redirects from entity ${id}`);
}

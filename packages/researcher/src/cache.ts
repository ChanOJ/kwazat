/**
 * Caches of the research pipeline, so that changing how sources are processed does not pay
 * again for gathering them (see docs/research-cost.md):
 *
 * - search cache: provider results per (provider, normalized query, params);
 * - page cache: KwazatBot fetch outcomes and page text per normalized URL. Third-party text:
 *   short retention outside local development, never for publishers refusing AI processing
 *   (their policy is checked again before every use, cached or not);
 * - corpora (research_corpora, see pipeline.ts) expire with `corpusDays`.
 *
 * Retention defaults are long with the local PGlite database (development: iterate for days on
 * the same articles) and short with a remote DATABASE_URL (staging, production).
 */
import { createHash } from "node:crypto";
import { eq, lt, pageCache, researchCorpora, searchCache, sql, type Db } from "@kwazat/db";
import { normalizeUrl } from "./claude.ts";
import type { FetchOutcome } from "./fetcher.ts";
import type { SearchProvider, SearchQuery, SearchResult } from "./search/index.ts";

export type CacheTtls = { searchDays: number; pageDays: number; corpusDays: number };

const DEV_TTLS: CacheTtls = { searchDays: 90, pageDays: 90, corpusDays: 365 };
const REMOTE_TTLS: CacheTtls = { searchDays: 3, pageDays: 2, corpusDays: 30 };

function days(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Expected a number of days, got "${value}"`);
  return n;
}

/** Retention from KWAZAT_*_CACHE_DAYS, else the development or remote defaults. */
export function cacheTtls(env: NodeJS.ProcessEnv = process.env): CacheTtls {
  const base = env.DATABASE_URL ? REMOTE_TTLS : DEV_TTLS;
  return {
    searchDays: days(env.KWAZAT_SEARCH_CACHE_DAYS, base.searchDays),
    pageDays: days(env.KWAZAT_PAGE_CACHE_DAYS, base.pageDays),
    corpusDays: days(env.KWAZAT_CORPUS_CACHE_DAYS, base.corpusDays),
  };
}

const cutoff = (ttlDays: number, now: Date) => new Date(now.getTime() - ttlDays * 86_400_000);

/** Deletes expired rows (third-party text must not outlive its retention). */
export async function purgeExpired(db: Db, ttls: CacheTtls, now = new Date()): Promise<void> {
  await db.delete(searchCache).where(lt(searchCache.fetchedAt, cutoff(ttls.searchDays, now)));
  await db.delete(pageCache).where(lt(pageCache.fetchedAt, cutoff(ttls.pageDays, now)));
  await db.delete(researchCorpora).where(lt(researchCorpora.createdAt, cutoff(ttls.corpusDays, now)));
}

// --- Search cache ----------------------------------------------------------------------------

/** Normalized query and the provider parameters that change the results. */
export function normalizeQuery(query: SearchQuery): SearchQuery {
  return {
    q: query.q.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase(),
    lang: query.lang?.trim().toLowerCase() || undefined,
    country: query.country?.trim().toUpperCase() || undefined,
    count: query.count,
  };
}

export function searchKey(providerId: string, query: SearchQuery): string {
  const n = normalizeQuery(query);
  return createHash("sha256")
    .update(JSON.stringify([providerId, n.q, n.lang ?? null, n.country ?? null, n.count ?? null]))
    .digest("hex");
}

/** Provider results for a query, from the cache when fresh (`cached`: nothing was paid). */
export async function cachedSearch(
  db: Db,
  provider: SearchProvider,
  query: SearchQuery,
  opts: { ttlDays: number; refresh?: boolean; now?: Date; beforeCall?: () => Promise<unknown> },
): Promise<{ results: SearchResult[]; cached: boolean }> {
  const key = searchKey(provider.id, query);
  const now = opts.now ?? new Date();
  if (!opts.refresh) {
    const [row] = await db.select().from(searchCache).where(eq(searchCache.key, key));
    if (row && row.fetchedAt > cutoff(opts.ttlDays, now)) return { results: row.results as SearchResult[], cached: true };
  }
  await opts.beforeCall?.();
  const results = await provider.search(query);
  const values = { key, provider: provider.id, query: normalizeQuery(query) as Record<string, unknown>, results, fetchedAt: now };
  await db
    .insert(searchCache)
    .values(values)
    .onConflictDoUpdate({ target: searchCache.key, set: { results, query: values.query, fetchedAt: now } });
  return { results, cached: false };
}

// --- Page cache ------------------------------------------------------------------------------

/** What the pipeline needs from KwazatBot (an interface, so tests can stay offline). */
export type PageFetcher = {
  policy(url: string): Promise<string | null>;
  fetch(url: string): Promise<FetchOutcome>;
};

/**
 * Fetches a page through the cache. The publisher's policy (registry opt-out, robots.txt,
 * TDMRep) is always checked first and live: an opted-out page is never served from the cache
 * and its text is never stored. Transient failures are not cached.
 */
export async function cachedFetch(
  db: Db,
  fetcher: PageFetcher,
  url: string,
  opts: { ttlDays: number; refresh?: boolean; now?: Date },
): Promise<FetchOutcome & { cached: boolean }> {
  const refused = await fetcher.policy(url);
  if (refused) return { url, status: "snippet_only", reason: refused, title: null, text: null, cached: false };

  const key = normalizeUrl(url);
  const now = opts.now ?? new Date();
  if (!opts.refresh) {
    const [row] = await db.select().from(pageCache).where(eq(pageCache.url, key));
    if (row && row.fetchedAt > cutoff(opts.ttlDays, now)) {
      return { url, status: row.status as FetchOutcome["status"], reason: row.reason, title: row.title, text: row.text, cached: true };
    }
  }
  const outcome = await fetcher.fetch(url);
  if (outcome.status !== "failed") {
    // Text only for pages read in full; a page-level refusal (TDM header, meta tag) keeps none.
    const text = outcome.status === "fetched" ? outcome.text : null;
    const values = { url: key, status: outcome.status, reason: outcome.reason, title: outcome.title, text, fetchedAt: now };
    await db
      .insert(pageCache)
      .values(values)
      .onConflictDoUpdate({
        target: pageCache.url,
        set: { status: sql`excluded.status`, reason: sql`excluded.reason`, title: sql`excluded.title`, text: sql`excluded.text`, fetchedAt: now },
      });
  }
  return { ...outcome, cached: false };
}

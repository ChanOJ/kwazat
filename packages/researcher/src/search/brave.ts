/**
 * Brave Search API (https://api-docs.search.brave.software). Independent index, AI inference
 * rights included in the Search plan; each account gets a monthly credit (~1,000 queries).
 * Key: BRAVE_SEARCH_API_KEY (Proton Pass, see secrets.env).
 */
import type { SearchProvider, SearchQuery, SearchResult } from "./types.ts";

const ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

type BraveResult = {
  url: string;
  title: string;
  description?: string;
  extra_snippets?: string[];
  page_age?: string;
  age?: string;
  profile?: { name?: string };
};

/** Brave returns light HTML (<strong>) and entities in titles and snippets. */
const clean = (s: string | undefined) =>
  (s ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();

export class BraveSearch implements SearchProvider {
  readonly id = "brave";
  readonly costPerQueryUsd = 5 / 1000;
  private readonly key: string;

  constructor(key = process.env.BRAVE_SEARCH_API_KEY) {
    if (!key) {
      throw new Error(
        "BRAVE_SEARCH_API_KEY is not set. Create a key at https://api-dashboard.search.brave.com, store it in " +
          "Proton Pass (vault Waza, item brave-search-api-key) and uncomment it in secrets.env, " +
          "or run with --search-provider anthropic.",
      );
    }
    this.key = key;
  }

  async search(query: SearchQuery): Promise<SearchResult[]> {
    const url = new URL(ENDPOINT);
    url.searchParams.set("q", query.q);
    url.searchParams.set("count", String(Math.min(query.count ?? 20, 20)));
    url.searchParams.set("extra_snippets", "true");
    url.searchParams.set("safesearch", "off");
    if (query.lang) url.searchParams.set("search_lang", query.lang);
    if (query.country) url.searchParams.set("country", query.country.toLowerCase());

    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        headers: { Accept: "application/json", "X-Subscription-Token": this.key },
      });
      // 429: rate limit (1 request per second on small plans).
      if (res.status === 429 && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1100 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`Brave Search ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = (await res.json()) as { web?: { results?: BraveResult[] } };
      return (json.web?.results ?? []).map((r) => ({
        url: r.url,
        title: clean(r.title),
        snippet: clean(r.description),
        extraSnippets: (r.extra_snippets ?? []).map(clean),
        publishedAt: r.page_age ?? r.age ?? null,
        siteName: r.profile?.name ?? null,
      }));
    }
  }
}

/**
 * Brave Search API (https://api-docs.search.brave.software). Independent index, AI inference
 * rights included in the Search plan; each account gets a monthly credit (~1,000 queries).
 * Key: BRAVE_SEARCH_API_KEY (Proton Pass, see secrets.env).
 */
import type { SearchProvider, SearchQuery, SearchResult } from "./types.ts";
import { parseHTML } from "linkedom";

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

/**
 * Brave returns light HTML (<strong>) and entities in titles and snippets: parsed as HTML and
 * reduced to its text, so no tag survives (regex stripping can leave nested tags behind).
 */
const clean = (s: string | undefined) => {
  if (!s) return "";
  const { document } = parseHTML("<!doctype html><html><body></body></html>");
  document.body.innerHTML = s;
  return (document.body.textContent ?? "").replace(/\s+/g, " ").trim();
};

function braveKey(key = process.env.BRAVE_SEARCH_API_KEY): string {
  if (!key) {
    throw new Error(
      "BRAVE_SEARCH_API_KEY is not set. Create a key at https://api-dashboard.search.brave.com, store it in " +
        "Proton Pass (vault Kwazat, item brave-search-api-key) and uncomment it in secrets.env, " +
        "or run with --search-provider anthropic.",
    );
  }
  return key;
}

async function braveGet(url: URL, key: string): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Accept: "application/json", "X-Subscription-Token": key } });
    // 429: rate limit (1 request per second on small plans).
    if (res.status === 429 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1100 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`Brave Search ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
}

/** Web Search endpoint: result pages for humans (title, description, extra snippets). */
export class BraveSearch implements SearchProvider {
  readonly id = "brave";
  readonly costPerQueryUsd = 5 / 1000;
  private readonly key = braveKey();

  async search(query: SearchQuery): Promise<SearchResult[]> {
    const url = new URL(ENDPOINT);
    url.searchParams.set("q", query.q);
    url.searchParams.set("count", String(Math.min(query.count ?? 20, 20)));
    url.searchParams.set("extra_snippets", "true");
    url.searchParams.set("safesearch", "off");
    if (query.lang) url.searchParams.set("search_lang", query.lang);
    if (query.country) url.searchParams.set("country", query.country.toLowerCase());

    const json = (await braveGet(url, this.key)) as { web?: { results?: BraveResult[] } };
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

type ContextResponse = {
  grounding?: { generic?: { url: string; title: string; snippets: string[] }[] };
  sources?: Record<string, { title?: string; hostname?: string; age?: (string | null)[]; description?: string }>;
};

/**
 * LLM Context endpoint: ranked passages of the most relevant pages, from Brave's index, for AI
 * grounding. Same price as Web Search. Passages of publishers refusing AI processing are trimmed
 * to a snippet by the research step.
 */
export class BraveContext implements SearchProvider {
  readonly id = "brave-context";
  readonly costPerQueryUsd = 5 / 1000;
  private readonly key = braveKey();

  async search(query: SearchQuery): Promise<SearchResult[]> {
    const url = new URL("https://api.search.brave.com/res/v1/llm/context");
    url.searchParams.set("q", query.q);
    url.searchParams.set("count", String(Math.min(query.count ?? 20, 50)));
    url.searchParams.set("maximum_number_of_urls", String(Math.min(query.count ?? 20, 50)));
    url.searchParams.set("maximum_number_of_tokens", String(CONTEXT_TOKENS_PER_QUERY));
    url.searchParams.set("enable_source_metadata", "true");
    url.searchParams.set("safesearch", "off");
    if (query.lang) url.searchParams.set("search_lang", query.lang);
    if (query.country) url.searchParams.set("country", query.country.toLowerCase());

    const json = (await braveGet(url, this.key)) as ContextResponse;
    return (json.grounding?.generic ?? []).map((g) => {
      const meta = json.sources?.[g.url];
      const passages = g.snippets.map((p) => p.trim()).filter(Boolean);
      return {
        url: g.url,
        title: clean(g.title || meta?.title),
        snippet: clean(meta?.description) || (passages[0] ?? "").slice(0, 300),
        extraSnippets: [],
        publishedAt: meta?.age?.[1] ?? meta?.age?.[0] ?? null,
        siteName: meta?.hostname ?? null,
        passages,
      };
    });
  }
}

/** Context budget per query; four queries per section stay around 25,000 input tokens. */
const CONTEXT_TOKENS_PER_QUERY = 6000;

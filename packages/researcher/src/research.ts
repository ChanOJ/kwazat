/**
 * Research with a web search provider (Brave in alpha) and KwazatBot, instead of Claude's
 * server-side web tools:
 *
 *   1. plan    — a small model writes the search queries for the section;
 *   2. search  — the provider returns results (title, snippets), past included;
 *   3. filter  — excluded domains dropped; in restricted mode, only the selected sources kept;
 *   4. triage  — a small model picks the results worth reading in full;
 *   5. fetch   — KwazatBot downloads them within the publishers' wishes (see fetcher.ts);
 *                publishers that refuse AI processing are used through their snippets only;
 *   6. notes   — the research model writes the section notes from these documents only.
 *
 * The output has the same shape as the previous pipeline (notes + retrieved URLs), so the
 * extraction, verification and confidence steps are unchanged.
 */
import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import {
  addUsage,
  assertNotRefused,
  client,
  countryContext,
  emptyUsage,
  fallbackFor,
  normalizeUrl,
  subjectBlock,
  toolBudget,
  usageOf,
  type ResearchResult,
  type RunConfig,
  type SubjectContext,
  type Usage,
} from "./claude.ts";
import type { Db } from "@kwazat/db";
import { cachedFetch, cachedSearch, type CacheTtls, type PageFetcher } from "./cache.ts";
import { Fetcher, type FetchOutcome, type FetchStatus } from "./fetcher.ts";
import type { Playbook, ResearchSection } from "./playbook.ts";
import { createSearchProvider, type SearchProvider, type SearchResult } from "./search/index.ts";
import { hostOf, isExcluded, lookupSource, type Registry, type SourceSelection } from "./sources.ts";

const RESULTS_PER_QUERY = 10;
/** Extra candidates to try when some pages turn out to be snippet-only. */
const TRIAGE_EXTRA = 3;
/** What is kept from provider passages of a publisher refusing AI processing ("very short extract"). */
const OPT_OUT_SNIPPET_CHARS = 300;

export type Doc = SearchResult & {
  index: number;
  tierLabel: string;
  /** Why the page may not be read in full (publisher opt-out, robots.txt...), null if it may. */
  refusal: string | null;
  fetch: FetchOutcome | null;
};

async function jsonCall<T>(
  model: string,
  system: string,
  user: string,
  schema: Record<string, unknown>,
): Promise<{ data: T; usage: Usage }> {
  const message = await client.beta.messages.create({
    model,
    max_tokens: 4000,
    ...fallbackFor(model),
    system,
    output_config: { effort: "low", format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: user }],
  });
  assertNotRefused(message);
  const text = message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return { data: JSON.parse(text) as T, usage: usageOf(message) };
}

/**
 * What the planner and the triage are told to look for: the section's `search_topic`, or its
 * instructions when it has none. Only this (not the instructions) is part of the corpus key.
 */
export function searchTopicOf(section: ResearchSection): string {
  return section.search_topic?.trim() || section.instructions;
}

// --- 1. Plan ---------------------------------------------------------------------------------

type PlannedQuery = { q: string; lang: string; country: string | null };

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["queries"],
  properties: {
    queries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["q", "lang", "country"],
        properties: {
          q: { type: "string" },
          lang: { type: "string", description: "ISO 639-1 language of the query" },
          country: { type: ["string", "null"], description: "ISO 3166-1 alpha-2 country to favour, or null" },
        },
      },
    },
  },
};

const PLAN_SYSTEM = `You plan web searches for a researcher building factual profile sheets of public figures,
brands and products. Write search-engine queries (no site: operators, no quotes unless needed
for a full name). Cover the subject's country language and English. Look for the most recent
developments first (final decisions, appeals, latest status), then the history.`;

async function planQueries(section: ResearchSection, subject: SubjectContext, sources: SourceSelection, n: number, config: RunConfig) {
  const today = new Date().toISOString().slice(0, 10);
  return jsonCall<{ queries: PlannedQuery[] }>(
    config.extractModel,
    PLAN_SYSTEM,
    `Subject:\n${subjectBlock(subject)}\n\nSection: ${section.title}\n${searchTopicOf(section)}${countryContext(sources)}\n\n` +
      `Write exactly ${n} distinct queries. Today's date: ${today}`,
    PLAN_SCHEMA,
  );
}

// --- 3. Filter -------------------------------------------------------------------------------

function tierLabel(registry: Registry, url: string): string {
  const entry = lookupSource(registry, url);
  if (!entry) return "not in registry";
  return entry.tier === null ? "unrated" : `tier ${entry.tier}${entry.tier === 3 ? " (positions only)" : ""}`;
}

function keep(registry: Registry, sources: SourceSelection, url: string): boolean {
  if (isExcluded(registry, url)) return false;
  if (sources.mode !== "restricted") return true;
  const host = hostOf(url);
  return !!host && sources.sources.some((s) => host === s.domain || host.endsWith(`.${s.domain}`));
}

// --- 4. Triage -------------------------------------------------------------------------------

const TRIAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["read"],
  properties: { read: { type: "array", items: { type: "integer" }, description: "Result indexes, most useful first" } },
};

type Listed = SearchResult & { index: number; tierLabel: string };

function docHeader(d: Listed): string {
  return `[${d.index}] ${d.title} — ${d.siteName ?? hostOf(d.url)} (${d.tierLabel})${d.publishedAt ? ` — ${d.publishedAt}` : ""}`;
}

async function triage(section: ResearchSection, subject: SubjectContext, docs: Listed[], n: number, config: RunConfig) {
  const list = docs.map((d) => `${docHeader(d)}\n${d.url}\n${d.snippet}`).join("\n\n");
  return jsonCall<{ read: number[] }>(
    config.extractModel,
    "You select which search results are worth reading in full for a factual research task.",
    `Subject: ${subject.label}${subject.description ? ` (${subject.description})` : ""}\nSection: ${section.title}\n` +
      `${searchTopicOf(section)}\n\nPick up to ${n} results most likely to contain the key facts, most useful first. ` +
      `Prefer official and primary sources, then tier 1 outlets, and recent results. Ignore results about homonyms.\n\n${list}`,
    TRIAGE_SCHEMA,
  );
}

// --- 6. Notes --------------------------------------------------------------------------------

const NOTES_SYSTEM = (playbook: Playbook) => `You are a meticulous research assistant building factual, sourced profile sheets.

Scope: ${playbook.scope}

Editorial rules:
${playbook.style}

You are given web search results (titles and snippets) and, for some of them, the full public
text of the page. Some publishers refuse AI processing of their pages: for those you only have
the search engine's title and snippets, which you may use as sources.

Method:
- Use only the documents provided. Do not add knowledge of your own.
- Prefer official sources and higher-tier outlets; cross-check important claims across documents.
- Look for the most recent developments (final decisions, appeals, latest status), then the history.
- Write your findings as research notes in English: one paragraph per item, with every relevant
  detail (dates, courts, outlets, procedural stage), followed by the exact URLs of the documents
  that support it, copied exactly as given.
- If the documents contain nothing relevant, say so explicitly. An empty result is a valid result.`;

function docBlock(d: Doc): string {
  const content = d.fetch?.status === "fetched" ? "full text" : d.passages?.length ? "passages" : "snippets only";
  const body = [
    d.title,
    d.snippet,
    ...d.extraSnippets,
    ...(d.passages ?? []),
    d.fetch?.status === "fetched" ? `\n${d.fetch.text}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    `<document index="${d.index}" url="${d.url}" outlet="${d.siteName ?? hostOf(d.url)}" ` +
    `source="${d.tierLabel}" published="${d.publishedAt ?? "unknown"}" content="${content}">\n${body}\n</document>`
  );
}

async function writeNotes(playbook: Playbook, section: ResearchSection, subject: SubjectContext, sources: SourceSelection, docs: Doc[], config: RunConfig) {
  const model = config.researchModel;
  const today = new Date().toISOString().slice(0, 10);
  const message = await client.beta.messages.create({
    model,
    max_tokens: 8000,
    ...fallbackFor(model),
    system: NOTES_SYSTEM(playbook),
    output_config: { effort: config.researchEffort },
    messages: [
      {
        role: "user",
        content:
          `Subject (make sure every finding is about this exact person or group, not a homonym):\n${subjectBlock(subject)}\n\n` +
          `Section: ${section.title}\n${section.instructions}${countryContext(sources)}\n\nToday's date: ${today}\n\n` +
          `<documents>\n${docs.map(docBlock).join("\n")}\n</documents>`,
      },
    ],
  });
  assertNotRefused(message);
  const notes = message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  return { notes, usage: usageOf(message), model: message.model };
}

// --- Orchestration ---------------------------------------------------------------------------
//
// Two halves, cached separately (see pipeline.ts and docs/research-cost.md):
//   gather (plan, search, filter, triage, fetch) → a corpus, keyed by what shapes the queries;
//   notes (hydrate the corpus with page text, write the notes) → keyed by instructions + corpus.

/** A gathered document as stored in research_corpora: no page text (that lives in page_cache). */
export type CorpusDoc = SearchResult & {
  index: number;
  tierLabel: string;
  /** KwazatBot's outcome when the triage picked the page, null otherwise. */
  fetch: { status: FetchStatus; reason: string | null; title: string | null } | null;
};

/** Usage per pipeline stage, stored in section_runs.usage.stages to see where the money goes. */
export type Stage = "plan" | "search" | "triage" | "notes" | "extraction" | "research";
export type StageUsage = Partial<Record<Stage, Usage>>;

export type ResearchDeps = {
  db: Db;
  ttls: CacheTtls;
  provider?: SearchProvider;
  fetcher?: PageFetcher;
  /** Bypass the search and page caches (rebuild the corpus from fresh results). */
  refresh?: boolean;
  log?: (line: string) => void;
};

const stderrLog = (line: string) => process.stderr.write(`\n    ${line}`);

/** Provider passages of publishers refusing AI processing are cut down to a short snippet. */
function trimRefused<T extends SearchResult>(d: T): T {
  if (!d.passages?.length) return d;
  return { ...d, snippet: (d.snippet || d.passages.join(" ")).slice(0, OPT_OUT_SNIPPET_CHARS), passages: [] };
}

export function defaultFetcher(registry: Registry): PageFetcher {
  return new Fetcher({ aiOptOutDomains: registry.aiOptOut });
}

/** Plan, search, filter, triage and fetch: the paid part that does not depend on the instructions. */
export async function gatherCorpus(
  section: ResearchSection,
  subject: SubjectContext,
  config: RunConfig,
  sources: SourceSelection,
  registry: Registry,
  deps: ResearchDeps,
): Promise<{ docs: CorpusDoc[]; stages: StageUsage }> {
  const provider =
    deps.provider ?? createSearchProvider(config.searchProvider as Exclude<RunConfig["searchProvider"], "anthropic">);
  const fetcher = deps.fetcher ?? defaultFetcher(registry);
  const log = deps.log ?? stderrLog;
  const budget = toolBudget(section, config);
  const stages: StageUsage = {};

  // 1-2. Plan and search (cached per normalized query).
  const plan = await planQueries(section, subject, sources, Math.max(1, budget.searches), config);
  stages.plan = plan.usage;
  const queries = plan.data.queries.slice(0, Math.max(1, budget.searches));
  const seen = new Set<string>();
  const found: (SearchResult & { index: number; tierLabel: string; refusal: string | null })[] = [];
  let paid = 0;
  for (const q of queries) {
    const query = { q: q.q, lang: q.lang, country: q.country ?? undefined, count: RESULTS_PER_QUERY };
    const { results, cached } = await cachedSearch(deps.db, provider, query, {
      ttlDays: deps.ttls.searchDays,
      refresh: deps.refresh,
      // Provider rate limits (1 request/s): wait only between calls actually sent.
      beforeCall: paid > 0 ? () => new Promise((r) => setTimeout(r, 1100)) : undefined,
    });
    if (!cached) paid++;
    // 3. Filter and deduplicate.
    for (const r of results) {
      const key = normalizeUrl(r.url);
      if (seen.has(key) || !keep(registry, sources, r.url)) continue;
      seen.add(key);
      found.push({ ...r, index: found.length + 1, tierLabel: tierLabel(registry, r.url), refusal: null });
    }
    log(`search "${q.q}" (${q.lang}) → ${results.length} results${cached ? " (cached)" : ""}`);
  }
  const searchCost = paid * provider.costPerQueryUsd;
  stages.search = { ...emptyUsage(), webSearches: paid, searchCostUsd: searchCost, costUsd: searchCost };

  // 4-5. Access policy (free: robots.txt and TDMRep once per host), triage, fetch.
  await Promise.all(found.map(async (d) => (d.refusal = await fetcher.policy(d.url))));
  const docs: (CorpusDoc & { refusal: string | null })[] = found.map((d) => ({ ...(d.refusal ? trimRefused(d) : d), fetch: null }));
  const readable = docs.filter((d) => !d.refusal);
  log(`${readable.length} of ${docs.length} results may be read in full; the others are used through their snippets`);
  // Pages already covered by provider passages need no download.
  const toRead = readable.filter((d) => !d.passages?.length);
  if (toRead.length && budget.fetches > 0) {
    const picked = await triage(section, subject, toRead, budget.fetches + TRIAGE_EXTRA, config);
    stages.triage = picked.usage;
    let fetched = 0;
    for (const index of picked.data.read) {
      if (fetched >= budget.fetches) break;
      const doc = docs[index - 1];
      if (!doc || doc.fetch || doc.refusal) continue;
      const page = await cachedFetch(deps.db, fetcher, doc.url, { ttlDays: deps.ttls.pageDays, refresh: deps.refresh });
      doc.fetch = { status: page.status, reason: page.reason, title: page.title };
      if (page.status === "fetched") fetched++;
      log(`${page.status.padEnd(12)} ${doc.url}${page.reason ? ` (${page.reason})` : ""}${page.cached ? " (cached)" : ""}`);
    }
    stages.search = { ...stages.search, webFetches: fetched };
  }
  return { docs: docs.map(({ refusal: _refusal, ...d }) => d), stages };
}

/**
 * Turns a stored corpus back into documents for the notes: the publisher's policy is checked
 * again (an opt-out made since the corpus was gathered takes effect at once) and the text of
 * pages read in full comes from the page cache, or is downloaded again (free) when expired.
 */
export async function hydrateCorpus(corpus: CorpusDoc[], registry: Registry, deps: ResearchDeps): Promise<Doc[]> {
  const fetcher = deps.fetcher ?? defaultFetcher(registry);
  const docs: Doc[] = [];
  for (const d of corpus) {
    const refusal = await fetcher.policy(d.url);
    const doc: Doc = { ...(refusal ? trimRefused(d) : d), refusal, fetch: null };
    if (!refusal && d.fetch?.status === "fetched") {
      const { cached: _cached, ...page } = await cachedFetch(deps.db, fetcher, d.url, { ttlDays: deps.ttls.pageDays });
      doc.fetch = page;
    } else if (d.fetch) {
      doc.fetch = { url: d.url, status: refusal ? "snippet_only" : d.fetch.status, reason: refusal ?? d.fetch.reason, title: d.fetch.title, text: null };
    }
    docs.push(doc);
  }
  return docs;
}

/** Notes from a hydrated corpus (the expensive call: research model over the documents). */
export async function notesFromDocs(
  playbook: Playbook,
  section: ResearchSection,
  subject: SubjectContext,
  sources: SourceSelection,
  docs: Doc[],
  config: RunConfig,
): Promise<ResearchResult & { stages: StageUsage }> {
  if (!docs.length) {
    return { notes: "No search results.", retrievedUrls: [], usage: emptyUsage(), model: config.researchModel, stages: {} };
  }
  const notes = await writeNotes(playbook, section, subject, sources, docs, config);
  return { notes: notes.notes, retrievedUrls: docs.map((d) => normalizeUrl(d.url)), usage: notes.usage, model: notes.model, stages: { notes: notes.usage } };
}

const fingerprint = (parts: unknown[]) =>
  createHash("sha256")
    .update(parts.map(String).join("\n"))
    .digest("hex")
    .slice(0, 12);

/** Fingerprint of the gathering prompts and logic, part of the corpus key. */
export const GATHER_FINGERPRINT = fingerprint([
  PLAN_SYSTEM,
  JSON.stringify(PLAN_SCHEMA),
  planQueries,
  keep,
  triage,
  searchTopicOf,
  gatherCorpus,
  RESULTS_PER_QUERY,
  TRIAGE_EXTRA,
  OPT_OUT_SNIPPET_CHARS,
]);

/** Fingerprint of the notes prompts and logic, part of the notes key. */
export const NOTES_FINGERPRINT = fingerprint([NOTES_SYSTEM, docBlock, writeNotes, hydrateCorpus, notesFromDocs, trimRefused]);

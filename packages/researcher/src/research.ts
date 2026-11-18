/**
 * Research with a web search provider (Brave in alpha) and WazaBot, instead of Claude's
 * server-side web tools:
 *
 *   1. plan    — a small model writes the search queries for the section;
 *   2. search  — the provider returns results (title, snippets), past included;
 *   3. filter  — excluded domains dropped; in restricted mode, only the selected sources kept;
 *   4. triage  — a small model picks the results worth reading in full;
 *   5. fetch   — WazaBot downloads them within the publishers' wishes (see fetcher.ts);
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
import { Fetcher, type FetchOutcome } from "./fetcher.ts";
import type { Playbook, ResearchSection } from "./playbook.ts";
import { createSearchProvider, type SearchProvider, type SearchResult } from "./search/index.ts";
import { hostOf, isExcluded, lookupSource, type Registry, type SourceSelection } from "./sources.ts";

const RESULTS_PER_QUERY = 10;
/** Extra candidates to try when some pages turn out to be snippet-only. */
const TRIAGE_EXTRA = 3;

type Doc = SearchResult & { index: number; tierLabel: string; fetch: FetchOutcome | null };

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
    `Subject:\n${subjectBlock(subject)}\n\nSection: ${section.title}\n${section.instructions}${countryContext(sources)}\n\n` +
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

function docHeader(d: Doc): string {
  return `[${d.index}] ${d.title} — ${d.siteName ?? hostOf(d.url)} (${d.tierLabel})${d.publishedAt ? ` — ${d.publishedAt}` : ""}`;
}

async function triage(section: ResearchSection, subject: SubjectContext, docs: Doc[], n: number, config: RunConfig) {
  const list = docs.map((d) => `${docHeader(d)}\n${d.url}\n${d.snippet}`).join("\n\n");
  return jsonCall<{ read: number[] }>(
    config.extractModel,
    "You select which search results are worth reading in full for a factual research task.",
    `Subject: ${subject.label}${subject.description ? ` (${subject.description})` : ""}\nSection: ${section.title}\n` +
      `${section.instructions}\n\nPick up to ${n} results most likely to contain the key facts, most useful first. ` +
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
  const content = d.fetch?.status === "fetched" ? "full text" : "snippets only";
  const body = [
    d.title,
    d.snippet,
    ...d.extraSnippets,
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
          `Subject (make sure every finding is about this exact person, not a homonym):\n${subjectBlock(subject)}\n\n` +
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

export async function researchWithSearch(
  playbook: Playbook,
  section: ResearchSection,
  subject: SubjectContext,
  config: RunConfig,
  sources: SourceSelection,
  registry: Registry,
  provider: SearchProvider = createSearchProvider(config.searchProvider as "brave"),
): Promise<ResearchResult> {
  const budget = toolBudget(section, config);
  const log = (line: string) => process.stderr.write(`\n    ${line}`);
  let usage = emptyUsage();

  // 1-2. Plan and search.
  const plan = await planQueries(section, subject, sources, Math.max(1, budget.searches), config);
  usage = addUsage(usage, plan.usage);
  const queries = plan.data.queries.slice(0, Math.max(1, budget.searches));
  const seen = new Set<string>();
  const docs: Doc[] = [];
  for (const [i, q] of queries.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, 1100)); // provider rate limits (1 request/s)
    const results = await provider.search({ q: q.q, lang: q.lang, country: q.country ?? undefined, count: RESULTS_PER_QUERY });
    // 3. Filter and deduplicate.
    for (const r of results) {
      const key = normalizeUrl(r.url);
      if (seen.has(key) || !keep(registry, sources, r.url)) continue;
      seen.add(key);
      docs.push({ ...r, index: docs.length + 1, tierLabel: tierLabel(registry, r.url), fetch: null });
    }
    log(`search "${q.q}" (${q.lang}) → ${results.length} results`);
  }
  const searchCost = queries.length * provider.costPerQueryUsd;
  usage = addUsage(usage, { ...emptyUsage(), webSearches: queries.length, searchCostUsd: searchCost, costUsd: searchCost });

  // 4-5. Triage and fetch.
  if (docs.length && budget.fetches > 0) {
    const picked = await triage(section, subject, docs, budget.fetches + TRIAGE_EXTRA, config);
    usage = addUsage(usage, picked.usage);
    const fetcher = new Fetcher({ aiOptOutDomains: registry.aiOptOut });
    let fetched = 0;
    for (const index of picked.data.read) {
      if (fetched >= budget.fetches) break;
      const doc = docs[index - 1];
      if (!doc || doc.fetch) continue;
      doc.fetch = await fetcher.fetch(doc.url);
      if (doc.fetch.status === "fetched") fetched++;
      log(`${doc.fetch.status.padEnd(12)} ${doc.url}${doc.fetch.reason ? ` (${doc.fetch.reason})` : ""}`);
    }
    usage = addUsage(usage, { ...emptyUsage(), webFetches: fetched });
  }
  process.stderr.write("\n  ");

  // 6. Notes.
  if (!docs.length) {
    return { notes: "No search results.", retrievedUrls: [], usage, model: config.researchModel };
  }
  const notes = await writeNotes(playbook, section, subject, sources, docs, config);
  usage = addUsage(usage, notes.usage);
  return { notes: notes.notes, retrievedUrls: docs.map((d) => normalizeUrl(d.url)), usage, model: notes.model };
}

/** Fingerprint of this pipeline's prompts and logic, part of the section hash. */
export const SEARCH_PIPELINE_FINGERPRINT = createHash("sha256")
  .update(
    [
      PLAN_SYSTEM,
      JSON.stringify(PLAN_SCHEMA),
      planQueries.toString(),
      keep.toString(),
      triage.toString(),
      NOTES_SYSTEM.toString(),
      docBlock.toString(),
      writeNotes.toString(),
      researchWithSearch.toString(),
      String(RESULTS_PER_QUERY),
      String(TRIAGE_EXTRA),
    ].join("\n"),
  )
  .digest("hex")
  .slice(0, 12);

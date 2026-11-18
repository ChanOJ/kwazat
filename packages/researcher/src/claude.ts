import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { Playbook, ResearchSection } from "./playbook.ts";
import { blockedDomainsFromError, recordBlocked } from "./access.ts";
import type { SourceSelection } from "./sources.ts";
import { SEARCH_PROVIDERS, type SearchProviderId } from "./search/index.ts";

export const client = new Anthropic();

// --- Run configuration -----------------------------------------------------------------------

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * Models and budgets for a run. Defaults are tuned for cost during the design phase:
 * Sonnet for the research step (judgement, cross-checking, homonyms), Haiku for the
 * mechanical notes-to-JSON extraction, and a low cap on web searches (billed per search).
 */
export type RunConfig = {
  researchModel: string;
  extractModel: string;
  researchEffort: Effort;
  /** Global caps applied on top of each section's own max_searches / max_fetches. */
  maxSearches: number;
  maxFetches: number;
  /** "auto" follows the registry rules; the others force a mode, e.g. to compare recall. */
  sourceMode: "auto" | "restricted" | "preferred";
  /** Web search provider (see search/index.ts); "anthropic" uses Claude's server-side web tools. */
  searchProvider: SearchProviderId;
};

export const DEFAULT_CONFIG: RunConfig = {
  researchModel: "claude-sonnet-5-5",
  extractModel: "claude-haiku-5-5",
  researchEffort: "medium",
  maxSearches: 4,
  maxFetches: 2,
  sourceMode: "auto",
  searchProvider: "brave",
};

function parseIntOr(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Expected a non-negative integer, got "${value}"`);
  return n;
}

/** Builds the run config from CLI overrides, then environment variables, then defaults. */
export function resolveConfig(overrides: Partial<Record<keyof RunConfig, string | undefined>> = {}): RunConfig {
  const env = process.env;
  const effort = overrides.researchEffort ?? env.KWAZAT_RESEARCH_EFFORT ?? DEFAULT_CONFIG.researchEffort;
  if (!EFFORTS.includes(effort as Effort)) throw new Error(`Invalid effort "${effort}" (${EFFORTS.join(", ")})`);
  return {
    researchModel: overrides.researchModel ?? env.KWAZAT_RESEARCH_MODEL ?? DEFAULT_CONFIG.researchModel,
    extractModel: overrides.extractModel ?? env.KWAZAT_EXTRACT_MODEL ?? DEFAULT_CONFIG.extractModel,
    researchEffort: effort as Effort,
    maxSearches: parseIntOr(overrides.maxSearches ?? env.KWAZAT_MAX_SEARCHES, DEFAULT_CONFIG.maxSearches),
    maxFetches: parseIntOr(overrides.maxFetches ?? env.KWAZAT_MAX_FETCHES, DEFAULT_CONFIG.maxFetches),
    sourceMode: parseSourceMode(overrides.sourceMode ?? env.KWAZAT_SOURCE_MODE),
    searchProvider: parseProvider(overrides.searchProvider ?? env.KWAZAT_SEARCH_PROVIDER),
  };
}

function parseProvider(value: string | undefined): SearchProviderId {
  if (!value) return DEFAULT_CONFIG.searchProvider;
  if ((SEARCH_PROVIDERS as readonly string[]).includes(value)) return value as SearchProviderId;
  throw new Error(`Invalid search provider "${value}" (${SEARCH_PROVIDERS.join(", ")})`);
}

function parseSourceMode(value: string | undefined): RunConfig["sourceMode"] {
  if (!value) return DEFAULT_CONFIG.sourceMode;
  if (value === "auto" || value === "restricted" || value === "preferred") return value;
  throw new Error(`Invalid source mode "${value}" (auto, restricted, preferred)`);
}

export const describeConfig = (c: RunConfig) =>
  `search ${c.searchProvider} · research ${c.researchModel} (effort ${c.researchEffort}, ≤${c.maxSearches} searches, ≤${c.maxFetches} fetches, sources ${c.sourceMode}) · extraction ${c.extractModel}`;

// --- Cost estimation -------------------------------------------------------------------------

type Price = {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  /** Some models charge more once the prompt exceeds a size threshold. */
  longContext?: { aboveInputTokens: number; input: number; output: number };
};

/** USD per million tokens. Estimates for reporting only; check current pricing before relying on them. */
const PRICES: Record<string, Price> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  "claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    cacheWrite: 0.125,
    cacheRead: 0.01,
    longContext: { aboveInputTokens: 100_000, input: 0.5, output: 2.5 },
  },
};
const WEB_SEARCH_USD = 10 / 1000;

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  webSearches: number;
  webFetches: number;
  /** Model tokens (input, output, cache). */
  tokenCostUsd: number;
  /** Web searches, billed per search whatever the model. */
  searchCostUsd: number;
  costUsd: number;
};

export const emptyUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  webSearches: 0,
  webFetches: 0,
  tokenCostUsd: 0,
  searchCostUsd: 0,
  costUsd: 0,
});

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    webSearches: a.webSearches + b.webSearches,
    webFetches: a.webFetches + b.webFetches,
    tokenCostUsd: a.tokenCostUsd + b.tokenCostUsd,
    searchCostUsd: a.searchCostUsd + b.searchCostUsd,
    costUsd: a.costUsd + b.costUsd,
  };
}

export const formatCost = (u: Usage) =>
  `$${u.costUsd.toFixed(3)} (tokens $${u.tokenCostUsd.toFixed(3)} + ${u.webSearches} searches $${u.searchCostUsd.toFixed(3)})`;

export function usageOf(message: Anthropic.Beta.BetaMessage): Usage {
  const u = message.usage;
  const price = PRICES[message.model];
  if (!price) console.error(`  (no price known for ${message.model}: cost reported as 0)`);
  const inputTokens = u.input_tokens;
  const cacheWriteTokens = u.cache_creation_input_tokens ?? 0;
  const cacheReadTokens = u.cache_read_input_tokens ?? 0;
  const promptTokens = inputTokens + cacheWriteTokens + cacheReadTokens;
  const long = price?.longContext && promptTokens > price.longContext.aboveInputTokens ? price.longContext : null;
  const webSearches = u.server_tool_use?.web_search_requests ?? 0;

  const tokenCostUsd = price
    ? (inputTokens * (long?.input ?? price.input) +
        u.output_tokens * (long?.output ?? price.output) +
        cacheWriteTokens * price.cacheWrite +
        cacheReadTokens * price.cacheRead) /
      1e6
    : 0;
  const searchCostUsd = webSearches * WEB_SEARCH_USD;
  return {
    inputTokens,
    outputTokens: u.output_tokens,
    cacheWriteTokens,
    cacheReadTokens,
    webSearches,
    webFetches: u.server_tool_use?.web_fetch_requests ?? 0,
    tokenCostUsd,
    searchCostUsd,
    costUsd: tokenCostUsd + searchCostUsd,
  };
}

// --- Helpers ---------------------------------------------------------------------------------

export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    for (const key of [...u.searchParams.keys()]) {
      if (key.startsWith("utm_") || key === "xtor" || key === "at_medium") u.searchParams.delete(key);
    }
    return u.toString().replace(/\/$/, "");
  } catch {
    return raw.trim();
  }
}

/** Collects every URL returned by server web tools (search results, fetched pages, citations). */
function collectRetrievedUrls(content: Anthropic.Beta.BetaContentBlock[]): string[] {
  const urls = new Set<string>();
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "url" && typeof value === "string") urls.add(normalizeUrl(value));
      else if (key !== "encrypted_content" && key !== "encrypted_index") walk(value);
    }
  };
  for (const block of content) {
    if (block.type.endsWith("_tool_result")) walk(block);
    if (block.type === "text") walk(block.citations ?? []);
  }
  return [...urls];
}

class RefusalError extends Error {}

export function assertNotRefused(message: Anthropic.Beta.BetaMessage) {
  if (message.stop_reason === "refusal") {
    const details = message.stop_details ? JSON.stringify(message.stop_details) : "no details";
    throw new RefusalError(`Model declined the request (${details})`);
  }
}

// Server-side fallback: if the model declines, the API re-runs the request on a fallback model.
// Only some models support it (not Haiku), so it is added per model.
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-2", "claude-fable-5-1"]);
export const fallbackFor = (model: string) =>
  FALLBACK_MODELS.has(model)
    ? {
        betas: ["server-side-fallback-2026-07-01"] as Anthropic.Beta.AnthropicBeta[],
        fallbacks: "default" as const,
      }
    : {};

// --- Research step ---------------------------------------------------------------------------

export type SubjectContext = {
  label: string;
  wikidataId: string | null;
  description: string | null;
  birthDate: string | null;
  occupations: string[];
  nationalities: string[];
};

export function subjectBlock(s: SubjectContext): string {
  return [
    `Name: ${s.label}`,
    s.wikidataId ? `Wikidata: ${s.wikidataId}` : null,
    s.description ? `Description: ${s.description}` : null,
    s.birthDate ? `Born: ${s.birthDate}` : null,
    s.occupations.length ? `Occupations: ${s.occupations.join(", ")}` : null,
    s.nationalities.length ? `Nationality: ${s.nationalities.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export type ResearchResult = { notes: string; retrievedUrls: string[]; usage: Usage; model: string };

const RESEARCH_SYSTEM = (playbook: Playbook) => `You are a meticulous research assistant building factual, sourced profile sheets.

Scope: ${playbook.scope}

Editorial rules:
${playbook.style}

Method:
- Your tool budget is small and stated in the request: plan your searches before starting.
  Write broad queries that return several relevant articles at once, and look for the most
  recent developments first (final decisions, appeals, latest status), then fill in the history.
- Read every search result you received before concluding: the information you need is often
  already in the result titles and snippets. Fetch a page only when the results lack key details.
- Use web search and web fetch to find and verify information. Prefer primary or recognised sources.
- Cross-check important claims with a second source when possible.
- When you are done, write your findings as research notes in English: one paragraph per item,
  with every relevant detail (dates, courts, outlets, procedural stage), followed by the exact
  URLs you retrieved that support it. Only cite URLs that appeared in your search results or
  fetched pages. Only the final notes are kept, so make them complete and self-contained.
- If you find nothing relevant, say so explicitly. An empty result is a valid result.`;

/** Effective tool budgets: the section's own limits, capped by the run config. */
export function toolBudget(section: ResearchSection, config: RunConfig) {
  return {
    searches: Math.min(section.max_searches, config.maxSearches),
    fetches: Math.min(section.max_fetches, config.maxFetches),
  };
}

/** Caps the size of each fetched page: full articles are the main driver of input tokens. */
const FETCH_MAX_CONTENT_TOKENS = 6000;

/**
 * Domain filters for both web tools. Restricted mode whitelists the selected sources; preferred
 * mode only blocks excluded domains (the API accepts one of the two lists, not both).
 */
function domainFilter(sources: SourceSelection) {
  return sources.mode === "restricted"
    ? { allowed_domains: sources.sources.map((s) => s.domain) }
    : sources.excluded.length
      ? { blocked_domains: sources.excluded }
      : {};
}

function researchTools(section: ResearchSection, config: RunConfig, sources: SourceSelection) {
  const budget = toolBudget(section, config);
  const filter = domainFilter(sources);
  return [
    ...(budget.searches > 0
      ? [{ type: "web_search_20260209" as const, name: "web_search" as const, max_uses: budget.searches, ...filter }]
      : []),
    ...(budget.fetches > 0
      ? [
          {
            type: "web_fetch_20260209" as const,
            name: "web_fetch" as const,
            max_uses: budget.fetches,
            max_content_tokens: FETCH_MAX_CONTENT_TOKENS,
            ...filter,
          },
        ]
      : []),
  ];
}

function sourcesBlock(playbook: Playbook, sources: SourceSelection): string {
  const list = sources.sources.map((s) => `${s.name} (${s.domain})`).join(", ");
  const scope =
    sources.mode === "restricted"
      ? "Your web tools only reach the following outlets and official sites. Do not use anything else."
      : "Preferred outlets and official sites (reputable outlets not listed here are also acceptable):";
  return `Sources: ${playbook.source_guidance}\n${scope}\n${list}${countryContext(sources)}`;
}

/** Context for subjects from countries flagged by the country indices (see sources/README.md). */
export function countryContext(sources: SourceSelection): string {
  const flagged = sources.flagged.map((c) => {
    const issues = [
      c.ruleOfLaw.low ? `courts and state bodies are not independent (${c.ruleOfLaw.reasons.join("; ")})` : null,
      c.pressFreedom.low ? `domestic media are not free (${c.pressFreedom.reasons.join("; ")})` : null,
    ].filter(Boolean);
    return `- ${c.name}: ${issues.join("; ")}.`;
  });
  const context = flagged.length
    ? `\nCountry context, from independent indices:\n${flagged.join("\n")}\n` +
      "Report decisions and statements of these institutions and media as attributed positions " +
      '("according to the X court", "state media reported"), never as established facts. Look for ' +
      "independent assessments: UN human rights bodies (ohchr.org, e.g. the Working Group on Arbitrary " +
      "Detention), international courts, foreign and exile media."
    : "";
  return context;
}

/**
 * The research notes are the model's final synthesis: the text written after its last tool
 * result. Earlier text is running commentary ("let me search for...") and is dropped.
 */
function finalNotes(content: Anthropic.Beta.BetaContentBlock[]): string {
  const lastToolIndex = content.findLastIndex((b) => b.type.endsWith("_tool_result") || b.type.endsWith("tool_use"));
  const text = (blocks: Anthropic.Beta.BetaContentBlock[]) =>
    blocks
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  return text(content.slice(lastToolIndex + 1)) || text(content);
}

export async function research(
  playbook: Playbook,
  section: ResearchSection,
  subject: SubjectContext,
  config: RunConfig,
  sources: SourceSelection,
): Promise<ResearchResult> {
  const model = config.researchModel;
  const budget = toolBudget(section, config);
  const today = new Date().toISOString().slice(0, 10);

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: "user",
      content: `Subject (make sure every finding is about this exact person, not a homonym):
${subjectBlock(subject)}

Section: ${section.title}
${section.instructions}

${sourcesBlock(playbook, sources)}
Search in the languages relevant to the subject (their country's language and English).
Tool budget: ${budget.searches} web searches and ${budget.fetches} page fetches in total.
Today's date: ${today}`,
    },
  ];

  let usage = emptyUsage();
  const content: Anthropic.Beta.BetaContentBlock[] = [];
  let servedBy = model;

  // Server tools can pause long turns (stop_reason "pause_turn"): send the turn back to continue.
  let current = sources;
  for (let i = 0; i < 6; i++) {
    let message: Anthropic.Beta.BetaMessage;
    try {
      const stream = client.beta.messages.stream({
        model,
        max_tokens: 32000,
        ...fallbackFor(model),
        system: RESEARCH_SYSTEM(playbook),
        output_config: { effort: config.researchEffort },
        tools: researchTools(section, config, current),
        messages,
      });
      message = await stream.finalMessage();
    } catch (err) {
      // Some publishers block the crawler: record them and retry once without them.
      const blocked = blockedDomainsFromError(err);
      if (!blocked || current !== sources) throw err;
      recordBlocked(blocked);
      current = { ...current, sources: current.sources.filter((s) => !blocked.includes(s.domain)) };
      i--;
      continue;
    }
    usage = addUsage(usage, usageOf(message));
    servedBy = message.model;
    content.push(...message.content);
    assertNotRefused(message);
    if (message.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: message.content });
  }

  return { notes: finalNotes(content), retrievedUrls: collectRetrievedUrls(content), usage, model: servedBy };
}

// --- Extraction step -------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>;

/** Structured outputs require closed objects with every property listed as required. */
function closeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(closeSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) out[k] = k === "enum" || k === "required" ? v : closeSchema(v);
  if (out.type === "object" && out.properties && typeof out.properties === "object") {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties);
  }
  return out;
}

const SOURCE_SCHEMA = {
  type: "object",
  properties: {
    url: { type: "string" },
    outlet: { type: "string", description: "Publication name, e.g. Le Monde." },
    published_at: { type: ["string", "null"], description: "ISO date if known." },
    quote: {
      type: ["string", "null"],
      description: "Short supporting excerpt, 25 words max, copied verbatim from the notes if available.",
    },
  },
};

export function extractionSchema(section: ResearchSection): JsonSchema {
  const properties: Record<string, unknown> = {};
  if (section.item_schema) {
    properties.facts = {
      type: "array",
      items: {
        type: "object",
        properties: {
          statement: {
            type: "string",
            description: "One neutral, attributed sentence in English summarising the item.",
          },
          fact_date: { type: ["string", "null"], description: "ISO date (possibly partial) the item refers to." },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          data: section.item_schema,
          sources: { type: "array", items: SOURCE_SCHEMA },
        },
      },
    };
  }
  if (section.emits_relations) {
    properties.relations = {
      type: "array",
      items: {
        type: "object",
        properties: {
          target_name: { type: "string" },
          target_kind: { type: "string", enum: ["person", "organisation"] },
          relation_type: { type: "string", enum: section.relation_types },
          strength: { type: "integer", enum: [1, 2, 3, 4, 5] },
          share_pct: { type: ["number", "null"], description: "Ownership share in percent, if relevant." },
          description: { type: "string", description: "One neutral sentence in English describing the link." },
          sources: { type: "array", items: SOURCE_SCHEMA },
        },
      },
    };
  }
  return closeSchema({ type: "object", properties }) as JsonSchema;
}

export type ExtractedSource = { url: string; outlet: string; published_at: string | null; quote: string | null };
export type ExtractedFact = {
  statement: string;
  fact_date: string | null;
  confidence: "high" | "medium" | "low";
  data: Record<string, unknown>;
  sources: ExtractedSource[];
};
export type ExtractedRelation = {
  target_name: string;
  target_kind: "person" | "organisation";
  relation_type: string;
  strength: number;
  share_pct: number | null;
  description: string;
  sources: ExtractedSource[];
};
export type Extraction = { facts: ExtractedFact[]; relations: ExtractedRelation[]; usage: Usage };

const EXTRACTION_SYSTEM = `You convert research notes into structured JSON for a profile sheet.
- Use only information present in the notes. Do not add knowledge of your own.
- Every item needs at least one source, and every source URL must be copied exactly from the
  notes. Drop items that have no source URL in the notes.
- Statements are neutral, attributed, and in English. Follow the presumption of innocence.
- Statements describe facts about the subject only: never mention the notes, the research
  process or what could not be checked. Express uncertainty through the structured fields
  (e.g. a lower confidence) instead.
- If the notes report nothing relevant, return empty arrays.`;

export async function extract(
  section: ResearchSection,
  subject: SubjectContext,
  notes: string,
  retrievedUrls: string[],
  config: RunConfig,
): Promise<Extraction> {
  const model = config.extractModel;
  const message = await client.beta.messages.create({
    model,
    max_tokens: 16000,
    ...fallbackFor(model),
    system: EXTRACTION_SYSTEM,
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: extractionSchema(section) },
    },
    messages: [
      {
        role: "user",
        content: `Subject: ${subject.label}${subject.wikidataId ? ` (${subject.wikidataId})` : ""}
Section: ${section.title}

<research_notes>
${notes || "(empty)"}
</research_notes>

<retrieved_urls>
${retrievedUrls.join("\n")}
</retrieved_urls>`,
      },
    ],
  });
  assertNotRefused(message);
  if (message.stop_reason === "max_tokens") throw new Error("Extraction truncated (max_tokens)");

  const text = message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const parsed = JSON.parse(text) as { facts?: ExtractedFact[]; relations?: ExtractedRelation[] };
  return { facts: parsed.facts ?? [], relations: parsed.relations ?? [], usage: usageOf(message) };
}

/**
 * Fingerprint of the research/extraction code (prompts, tool setup, parsing). Included in each
 * section hash so that editing a prompt in code marks cached sections as stale, like editing
 * a playbook does. Function sources are used so that no manual version bump is needed.
 */
export const PIPELINE_FINGERPRINT = createHash("sha256")
  .update(
    [
      RESEARCH_SYSTEM.toString(),
      research.toString(),
      researchTools.toString(),
      domainFilter.toString(),
      sourcesBlock.toString(),
      countryContext.toString(),
      finalNotes.toString(),
      String(FETCH_MAX_CONTENT_TOKENS),
      EXTRACTION_SYSTEM,
      extract.toString(),
      extractionSchema.toString(),
      JSON.stringify(SOURCE_SCHEMA),
    ].join("\n"),
  )
  .digest("hex")
  .slice(0, 12);

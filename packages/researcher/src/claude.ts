import Anthropic from "@anthropic-ai/sdk";
import type { Playbook, ResearchSection } from "./playbook.ts";

export const DEFAULT_MODEL = "claude-opus-5-5";

const client = new Anthropic();

// --- Cost estimation -------------------------------------------------------------------------

/** USD per million tokens. Estimates for reporting only; check current pricing before relying on them. */
const PRICES: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
};
const WEB_SEARCH_USD = 10 / 1000;

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  webSearches: number;
  webFetches: number;
  costUsd: number;
};

export const emptyUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  webSearches: 0,
  webFetches: 0,
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
    costUsd: a.costUsd + b.costUsd,
  };
}

function usageOf(message: Anthropic.Beta.BetaMessage): Usage {
  const u = message.usage;
  const price = PRICES[message.model] ?? PRICES[DEFAULT_MODEL]!;
  const webSearches = u.server_tool_use?.web_search_requests ?? 0;
  const webFetches = u.server_tool_use?.web_fetch_requests ?? 0;
  const usage = {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    webSearches,
    webFetches,
    costUsd: 0,
  };
  usage.costUsd =
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheWriteTokens * price.cacheWrite +
      usage.cacheReadTokens * price.cacheRead) /
      1e6 +
    webSearches * WEB_SEARCH_USD;
  return usage;
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

function assertNotRefused(message: Anthropic.Beta.BetaMessage) {
  if (message.stop_reason === "refusal") {
    const details = message.stop_details ? JSON.stringify(message.stop_details) : "no details";
    throw new RefusalError(`Model declined the request (${details})`);
  }
}

// Server-side fallback: if the model declines, the API re-runs the request on a fallback model.
const fallback = () => ({
  betas: ["server-side-fallback-2026-07-01"] as Anthropic.Beta.AnthropicBeta[],
  fallbacks: "default" as const,
});

// --- Research step ---------------------------------------------------------------------------

export type SubjectContext = {
  label: string;
  wikidataId: string | null;
  description: string | null;
  birthDate: string | null;
  occupations: string[];
  nationalities: string[];
};

function subjectBlock(s: SubjectContext): string {
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
- Use web search and web fetch to find and verify information. Prefer primary or recognised sources.
- Cross-check important claims with a second source when possible.
- Write your findings as research notes in English: one paragraph per item, with every relevant
  detail (dates, courts, outlets, procedural stage), followed by the exact URLs you retrieved that
  support it. Only cite URLs that appeared in your search results or fetched pages.
- If you find nothing relevant, say so explicitly. An empty result is a valid result.`;

export async function research(
  playbook: Playbook,
  section: ResearchSection,
  subject: SubjectContext,
  model: string,
): Promise<ResearchResult> {
  const preferred = section.preferred_sources.flatMap((l) => playbook.source_lists[l] ?? []);
  const today = new Date().toISOString().slice(0, 10);

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: "user",
      content: `Subject (make sure every finding is about this exact person, not a homonym):
${subjectBlock(subject)}

Section: ${section.title}
${section.instructions}

Sources: ${playbook.source_guidance}
Examples of preferred outlets for this section: ${[...new Set(preferred)].join(", ")}
Search in the languages relevant to the subject (their country's language and English).
Today's date: ${today}`,
    },
  ];

  let usage = emptyUsage();
  const content: Anthropic.Beta.BetaContentBlock[] = [];
  let servedBy = model;

  // Server tools can pause long turns (stop_reason "pause_turn"): send the turn back to continue.
  for (let i = 0; i < 6; i++) {
    const stream = client.beta.messages.stream({
      model,
      max_tokens: 32000,
      ...fallback(),
      system: RESEARCH_SYSTEM(playbook),
      output_config: { effort: "medium" },
      tools: [
        { type: "web_search_20260209", name: "web_search", max_uses: section.max_searches },
        { type: "web_fetch_20260209", name: "web_fetch", max_uses: section.max_fetches },
      ],
      messages,
    });
    const message = await stream.finalMessage();
    usage = addUsage(usage, usageOf(message));
    servedBy = message.model;
    content.push(...message.content);
    assertNotRefused(message);
    if (message.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: message.content });
  }

  const notes = content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  return { notes, retrievedUrls: collectRetrievedUrls(content), usage, model: servedBy };
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
- If the notes report nothing relevant, return empty arrays.`;

export async function extract(
  section: ResearchSection,
  subject: SubjectContext,
  notes: string,
  retrievedUrls: string[],
  model: string,
): Promise<Extraction> {
  const message = await client.beta.messages.create({
    model,
    max_tokens: 16000,
    ...fallback(),
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

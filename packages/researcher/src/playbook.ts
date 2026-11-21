import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import { EXTRACTION_FINGERPRINT, RESEARCH_FINGERPRINT, toolBudget, type RunConfig } from "./claude.ts";
import { GATHER_FINGERPRINT, NOTES_FINGERPRINT, searchTopicOf } from "./research.ts";
import { SourceTypeSchema, type SourceSelection } from "./sources.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const PLAYBOOKS_DIR = path.resolve(here, "../../../playbooks");

const JsonSchema: z.ZodType<Record<string, unknown>> = z.record(z.string(), z.unknown());

const WikidataSection = z.object({
  id: z.string(),
  title: z.string(),
  method: z.literal("wikidata"),
});

const ResearchSection = z.object({
  id: z.string(),
  title: z.string(),
  method: z.literal("research"),
  sensitive: z.boolean().default(false),
  ttl_days: z.number().int().positive(),
  /** Source types wanted from the registry (sources/*.yaml). */
  source_types: z.array(SourceTypeSchema).min(1),
  max_searches: z.number().int().positive().default(5),
  max_fetches: z.number().int().nonnegative().default(3),
  /**
   * What to search for, in a few lines: given to the query planner and the triage instead of
   * the instructions, so that rewording the instructions reuses the gathered corpus.
   */
  search_topic: z.string().optional(),
  instructions: z.string(),
  item_schema: JsonSchema.optional(),
  emits_relations: z.boolean().default(false),
  relation_types: z.array(z.string()).optional(),
});

const Section = z.discriminatedUnion("method", [WikidataSection, ResearchSection]);

const Playbook = z
  .object({
    id: z.string(),
    version: z.number().int().positive(),
    entity_type: z.enum(["person", "band", "brand", "product"]),
    label: z.string(),
    scope: z.string(),
    style: z.string(),
    source_guidance: z.string().default(""),
    sections: z.array(Section).min(1),
  })
  .superRefine((pb, ctx) => {
    const ids = new Set<string>();
    for (const s of pb.sections) {
      if (ids.has(s.id)) ctx.addIssue({ code: "custom", message: `Duplicate section id: ${s.id}` });
      ids.add(s.id);
      if (s.method !== "research") continue;
      if (!s.item_schema && !s.emits_relations) {
        ctx.addIssue({ code: "custom", message: `Section ${s.id}: needs item_schema or emits_relations` });
      }
      if (s.emits_relations && !s.relation_types?.length) {
        ctx.addIssue({ code: "custom", message: `Section ${s.id}: emits_relations requires relation_types` });
      }
    }
  });

export type Playbook = z.infer<typeof Playbook>;
export type PlaybookSection = Playbook["sections"][number];
export type ResearchSection = z.infer<typeof ResearchSection>;

export function loadPlaybook(id: string): Playbook {
  const file = path.join(PLAYBOOKS_DIR, `${id}.yaml`);
  const raw = parse(fs.readFileSync(file, "utf8"));
  const result = Playbook.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid playbook ${file}:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** Stable JSON serialization (sorted keys) so hashes don't depend on key order. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const sha = (value: unknown) => createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16);

/**
 * Cache keys of a research section, from the cheapest to rebuild to the most expensive:
 *
 *   gatherHash   what shapes the queries and which pages are read: section id, title,
 *                search topic (`search_topic`, else the instructions), the sources selected
 *                (source_types, sensitive, the subject's countries), the effective budgets,
 *                the search provider, the planner/triage model and the gathering code.
 *                Combined with the subject (pipeline.ts) it is the key of the stored corpus.
 *   notesHash    what shapes the notes written from a corpus: title, instructions, the
 *                playbook's scope and style, the research model and effort, the notes code.
 *                Combined with the corpus id it is the key of reusable notes.
 *   extractionHash  item_schema, relations, extraction model and code (notes → items).
 *
 * Not in any key: ttl_days (how long results stay valid, checked separately).
 */
export function gatherHash(
  playbook: Playbook,
  section: ResearchSection,
  config: RunConfig,
  sources: SourceSelection | null,
): string {
  return sha({
    playbook: playbook.id,
    section: section.id,
    title: section.title,
    topic: searchTopicOf(section),
    sources,
    budget: toolBudget(section, config),
    searchProvider: config.searchProvider,
    gatherModel: config.extractModel,
    pipeline: GATHER_FINGERPRINT,
  });
}

export function notesHash(playbook: Playbook, section: ResearchSection, config: RunConfig): string {
  return sha({
    title: section.title,
    instructions: section.instructions,
    scope: playbook.scope,
    style: playbook.style,
    researchModel: config.researchModel,
    researchEffort: config.researchEffort,
    pipeline: NOTES_FINGERPRINT,
  });
}

/**
 * Hash of everything that influences the research step of a section (what is searched and
 * read, and how the notes are written). With a search provider it combines the gather and notes
 * keys; with Claude's own web tools ("anthropic") the two cannot be separated.
 */
export function researchHash(
  playbook: Playbook,
  section: PlaybookSection,
  config: RunConfig,
  sources: SourceSelection | null,
): string {
  if (section.method === "research" && config.searchProvider !== "anthropic") {
    return sha([gatherHash(playbook, section, config, sources), notesHash(playbook, section, config)]);
  }
  const research = section.method === "research";
  // What only shapes the extracted items (schema, relations) does not change the research.
  const { item_schema: _schema, emits_relations: _emits, relation_types: _types, ttl_days: _ttl, ...researchPart } =
    section as Record<string, unknown>;
  return sha({
    section: researchPart,
    style: playbook.style,
    sourceGuidance: playbook.source_guidance,
    sources,
    researchModel: config.researchModel,
    researchEffort: config.researchEffort,
    // Effective budgets (not the raw caps): raising a cap above a section's limit changes nothing.
    budget: research ? toolBudget(section, config) : null,
    searchProvider: config.searchProvider,
    pipeline: RESEARCH_FINGERPRINT,
  });
}

/** Key of a stored corpus: the gather hash and the subject as the planner sees it. */
export const corpusKey = (gather: string, subject: string) => sha({ gather, subject });

/** Key of reusable notes: the notes hash and the exact corpus they were written from. */
export const notesKey = (notes: string, corpusId: string) => sha({ notes, corpusId });

/** Hash of what influences the extraction of items from the notes: schema, model, extraction code. */
export function extractionHash(section: PlaybookSection, config: RunConfig): string {
  const research = section.method === "research";
  return sha({
    title: section.title,
    itemSchema: research ? section.item_schema ?? null : null,
    emitsRelations: research ? section.emits_relations : null,
    relationTypes: research ? section.relation_types ?? null : null,
    extractModel: config.extractModel,
    pipeline: EXTRACTION_FINGERPRINT,
  });
}

/**
 * Hash of everything that influences a section's output: its research and its extraction. A
 * change in either makes existing results for this section stale. The source selection
 * depends on the subject's countries, so editing sources/FR.yaml only affects French subjects.
 */
export function sectionHash(
  playbook: Playbook,
  section: PlaybookSection,
  config: RunConfig,
  sources: SourceSelection | null,
): string {
  return sha([researchHash(playbook, section, config, sources), extractionHash(section, config)]);
}

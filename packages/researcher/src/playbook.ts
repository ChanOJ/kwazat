import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import { PIPELINE_FINGERPRINT, toolBudget, type RunConfig } from "./claude.ts";
import { SEARCH_PIPELINE_FINGERPRINT } from "./research.ts";
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
    entity_type: z.enum(["person", "brand", "product"]),
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

/**
 * Hash of everything that influences a section's output: the section definition, the shared
 * style rules, the sources selected for this subject, the models, effort and tool budgets. A
 * change in any of them makes existing results for this section stale. The source selection
 * depends on the subject's countries, so editing sources/FR.yaml only affects French subjects.
 */
export function sectionHash(
  playbook: Playbook,
  section: PlaybookSection,
  config: RunConfig,
  sources: SourceSelection | null,
): string {
  const research = section.method === "research";
  const payload = stableStringify({
    section,
    style: playbook.style,
    sourceGuidance: playbook.source_guidance,
    sources,
    researchModel: config.researchModel,
    extractModel: config.extractModel,
    researchEffort: config.researchEffort,
    // Effective budgets (not the raw caps): raising a cap above a section's limit changes nothing.
    budget: research ? toolBudget(section, config) : null,
    searchProvider: config.searchProvider,
    pipeline: config.searchProvider === "anthropic" ? PIPELINE_FINGERPRINT : SEARCH_PIPELINE_FINGERPRINT,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

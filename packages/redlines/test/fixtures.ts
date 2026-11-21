/**
 * Small fixture graphs with neutral placeholders (never real people or companies).
 */
import type { GraphEntity, GraphFact, GraphRelation, SheetGraph, Source } from "../src/types.ts";

export const SRC: Source[] = [{ url: "https://example.org/a", outlet: "Example Wire", publishedAt: "2026-01-01" }];

export function entity(id: string, type: GraphEntity["type"] = "person", wikidataId: string | null = null): GraphEntity {
  return { id, type, label: id, wikidataId };
}

let n = 0;
export function rel(
  from: string,
  type: string,
  to: string | null,
  extra: Partial<GraphRelation> = {},
): GraphRelation {
  return {
    id: `r${++n}`,
    fromEntityId: from,
    toEntityId: to,
    toWikidataId: null,
    toLabel: to ?? "Unresolved Co",
    relationType: type,
    sharePct: null,
    endedAt: null,
    reviewStatus: "published",
    sources: SRC,
    ...extra,
  };
}

export function fact(entityId: string, sectionId: string, data: Record<string, unknown>, extra: Partial<GraphFact> = {}): GraphFact {
  return {
    id: `f${++n}`,
    entityId,
    sectionId,
    statement: "According to Example Wire, ...",
    data,
    confidence: "high",
    reviewStatus: "published",
    sources: SRC,
    ...extra,
  };
}

/** Every section a person or band sheet can have, all published. */
export const PERSON_SECTIONS = { convictions: "published", ongoing_cases: "published", notable_relations: "published" } as const;
export const BAND_SECTIONS = { legal_proceedings: "published", members_conduct: "published" } as const;

export function graph(subjectId: string, parts: Partial<SheetGraph>): SheetGraph {
  return { subjectId, entities: [], facts: [], relations: [], sections: {}, ...parts };
}

export const conviction = (over: Record<string, unknown> = {}) => ({
  case_name: "Case 1",
  offenses: ["fraud"],
  offense_class: "misdemeanor",
  court: "Court",
  country: "XX",
  decision_date: "2025",
  procedural_stage: "final",
  is_final: true,
  appeal_pending: false,
  overturned: false,
  sentence: null,
  ...over,
});

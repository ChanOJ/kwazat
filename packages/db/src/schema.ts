import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const entityType = pgEnum("entity_type", ["person", "brand", "product"]);

export const reviewStatus = pgEnum("review_status", [
  "published", // visible to users
  "needs_review", // sensitive section or unverified sources: hidden until a human checks it
  "rejected",
]);

export const runStatus = pgEnum("run_status", ["running", "succeeded", "failed"]);

/** A source backing a fact or relation. Every displayed claim must have at least one. */
export type Source = {
  url: string;
  outlet: string;
  publishedAt: string | null;
  /** Short excerpt supporting the claim (kept short for copyright reasons). */
  quote: string | null;
  /** True when the URL was actually returned by web search/fetch during the run (anti-hallucination check). */
  verified: boolean;
  /** Registry tier of the outlet (1 reference, 2 reliable, 3 positions only), null if not listed. */
  tier?: number | null;
};

/** Canonical entity. For persons, `wikidataId` is the disambiguation key (no homonym confusion). */
export const entities = pgTable(
  "entities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: entityType("type").notNull(),
    wikidataId: text("wikidata_id"),
    label: text("label").notNull(),
    description: text("description"),
    aliases: jsonb("aliases").$type<string[]>().notNull().default([]),
    /** Deterministic identity block (from Wikidata): nationality, gender, photo, occupations, birth date... */
    identity: jsonb("identity").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("entities_wikidata_id_idx").on(t.wikidataId)],
);

/**
 * One execution of one playbook section for one entity.
 * `sectionHash` identifies the exact section definition used: when a playbook changes,
 * only sections whose hash differs need to be re-run.
 */
export const sectionRuns = pgTable(
  "section_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    playbookId: text("playbook_id").notNull(),
    playbookVersion: integer("playbook_version").notNull(),
    sectionId: text("section_id").notNull(),
    sectionHash: text("section_hash").notNull(),
    model: text("model").notNull(),
    status: runStatus("status").notNull().default("running"),
    /** Free-text research notes produced by the research step (kept for audit/debug). */
    researchNotes: text("research_notes"),
    /** URLs actually returned by the web tools during the run. */
    retrievedUrls: jsonb("retrieved_urls").$type<string[]>().notNull().default([]),
    usage: jsonb("usage").$type<Record<string, unknown>>(),
    costUsd: numeric("cost_usd", { precision: 10, scale: 4 }),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /** Only the latest successful run of a section is "current". */
    isCurrent: boolean("is_current").notNull().default(false),
  },
  (t) => [index("section_runs_entity_section_idx").on(t.entityId, t.sectionId)],
);

export type ConfidenceLevel = "high" | "medium" | "low";

/** An atomic, sourced statement displayed on a sheet. */
export const facts = pgTable(
  "facts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    sectionRunId: uuid("section_run_id")
      .notNull()
      .references(() => sectionRuns.id, { onDelete: "cascade" }),
    sectionId: text("section_id").notNull(),
    /** Neutral, attributed one-sentence statement ("According to Le Monde, ..."). */
    statement: text("statement").notNull(),
    /** Date the fact refers to (ISO, possibly partial: "2021" or "2021-03"). */
    factDate: text("fact_date"),
    /** Section-specific structured payload (validated against the playbook schema). */
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    sources: jsonb("sources").$type<Source[]>().notNull().default([]),
    confidence: text("confidence").$type<ConfidenceLevel>().notNull(),
    reviewStatus: reviewStatus("review_status").notNull().default("needs_review"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("facts_entity_section_idx").on(t.entityId, t.sectionId)],
);

/**
 * Edges of the entity graph (ownership, family, political, professional links).
 * The compatibility score is computed by walking this graph against the user's red lines.
 * `toEntityId` may be null while the target has not been resolved into its own entity yet.
 */
export const relations = pgTable(
  "relations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fromEntityId: uuid("from_entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    toEntityId: uuid("to_entity_id").references(() => entities.id, { onDelete: "set null" }),
    toLabel: text("to_label").notNull(),
    toWikidataId: text("to_wikidata_id"),
    /** e.g. spouse_of, child_of, parent_of, owned_by, member_of_party, wedding_witness_of... */
    relationType: text("relation_type").notNull(),
    /** Ownership share in percent, when relevant. */
    sharePct: numeric("share_pct", { precision: 6, scale: 3 }),
    /** 1 (weak) to 5 (strong); used by red-line matching. */
    strength: integer("strength").notNull().default(3),
    description: text("description"),
    sources: jsonb("sources").$type<Source[]>().notNull().default([]),
    /** "wikidata" for deterministic edges, otherwise the section run that produced it. */
    origin: text("origin").notNull(),
    sectionRunId: uuid("section_run_id").references(() => sectionRuns.id, { onDelete: "cascade" }),
    reviewStatus: reviewStatus("review_status").notNull().default("needs_review"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("relations_from_idx").on(t.fromEntityId),
    index("relations_to_wikidata_idx").on(t.toWikidataId),
  ],
);

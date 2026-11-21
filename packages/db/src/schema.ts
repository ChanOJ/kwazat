import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const entityType = pgEnum("entity_type", ["person", "band", "brand", "product"]);

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

/**
 * Canonical entity. `id` is Kwazat's own public identifier (UUIDv7, set by the application):
 * many entities (most products, many brands) have no Wikidata item. External identifiers
 * live in `entity_identifiers`.
 */
export const entities = pgTable(
  "entities",
  {
    id: uuid("id").primaryKey(),
    type: entityType("type").notNull(),
    /** Set when this entity turned out to duplicate another: its id then redirects there. */
    mergedInto: uuid("merged_into"),
    label: text("label").notNull(),
    description: text("description"),
    aliases: jsonb("aliases").$type<string[]>().notNull().default([]),
    /** Deterministic identity block (from Wikidata): nationality, gender, photo, occupations, birth date... */
    identity: jsonb("identity").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("entities_merged_into_idx").on(t.mergedInto)],
);

/**
 * Identifier schemes of other datasets. An entity can have several (a company: Wikidata,
 * SIREN, LEI; a product: GTIN barcode, Open Food Facts...). Lowercase, stable strings.
 */
export const IDENTIFIER_SCHEMES = ["wikidata", "gtin", "siren", "lei", "openfoodfacts", "isni"] as const;
export type IdentifierScheme = (typeof IDENTIFIER_SCHEMES)[number];

/** Correspondence between Kwazat entities and external identifiers. */
export const entityIdentifiers = pgTable(
  "entity_identifiers",
  {
    entityId: uuid("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    scheme: text("scheme").$type<IdentifierScheme>().notNull(),
    value: text("value").notNull(),
    /** Where the correspondence comes from (e.g. "wikidata", "openfoodfacts", "research"). */
    source: text("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.scheme, t.value] }),
    index("entity_identifiers_entity_idx").on(t.entityId),
  ],
);

/** Names and aliases of known entities, normalized, for instant search (trigram index). */
export const entityNames = pgTable(
  "entity_names",
  {
    entityId: uuid("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** ISO 639-1 code, "mul" for language-neutral names, null if unknown. */
    lang: text("lang"),
    normalized: text("normalized").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.entityId, t.normalized] }),
    index("entity_names_trgm_idx").using("gin", t.normalized.op("gin_trgm_ops")),
  ],
);

/**
 * Cached Wikidata candidate lists per normalized query, so that popular searches do not hit
 * Wikidata again. The full list is kept (not only known entities): homonyms must stay visible.
 */
export const wikidataSearchCache = pgTable(
  "wikidata_search_cache",
  {
    query: text("query").notNull(),
    lang: text("lang").notNull(),
    humansOnly: boolean("humans_only").notNull(),
    results: jsonb("results").$type<unknown[]>().notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.query, t.lang, t.humansOnly] })],
);

export const jobStatus = pgEnum("job_status", ["queued", "running", "succeeded", "failed"]);

/**
 * Background jobs (research runs...), processed by workers with SELECT ... FOR UPDATE SKIP
 * LOCKED. `dedupeKey` prevents the same work from being queued twice while one is pending.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey(),
    kind: text("kind").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: jobStatus("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("jobs_pending_dedupe_idx")
      .on(t.dedupeKey)
      .where(sql`${t.status} in ('queued', 'running')`),
    index("jobs_claim_idx").on(t.status, t.runAfter),
  ],
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
    /** Hash of the research step alone: equal hashes mean the saved notes are still valid. */
    researchHash: text("research_hash"),
    /** The research notes of an earlier run were reused (only the extraction ran again). */
    notesReused: boolean("notes_reused").notNull().default(false),
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

/**
 * Web search results per (provider, normalized query, provider params), so that re-running a
 * section does not pay the search provider again. Results are the provider's titles and
 * snippets (licensed for AI use by the provider). Expired rows are purged at each run.
 */
export const searchCache = pgTable(
  "search_cache",
  {
    /** sha256 of provider + normalized query + params (see researcher/src/cache.ts). */
    key: text("key").primaryKey(),
    provider: text("provider").notNull(),
    query: jsonb("query").$type<Record<string, unknown>>().notNull(),
    results: jsonb("results").$type<unknown[]>().notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("search_cache_fetched_at_idx").on(t.fetchedAt)],
);

/**
 * Pages downloaded by KwazatBot, per normalized URL. Holds third-party article text: short
 * retention outside local development, never exported, and never filled for a publisher that
 * refuses AI processing (only the outcome is kept, without text). The publisher's policy is
 * checked again before every use, so a later opt-out takes effect at once.
 */
export const pageCache = pgTable(
  "page_cache",
  {
    url: text("url").primaryKey(),
    status: text("status").notNull(),
    reason: text("reason"),
    title: text("title"),
    text: text("text"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("page_cache_fetched_at_idx").on(t.fetchedAt)],
);

/**
 * The material gathered for one section of one entity (plan, search, triage, fetch): search
 * results and fetch outcomes, without page text (that lives in `page_cache`). `corpusHash`
 * covers only what shapes the queries, so editing a section's wording reuses the corpus and
 * only re-runs the notes and the extraction.
 */
export const researchCorpora = pgTable(
  "research_corpora",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    sectionId: text("section_id").notNull(),
    corpusHash: text("corpus_hash").notNull(),
    docs: jsonb("docs").$type<unknown[]>().notNull(),
    /** What gathering it cost (planner, search, triage). */
    usage: jsonb("usage").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("research_corpora_entity_section_idx").on(t.entityId, t.sectionId)],
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

export * from "./auth-schema.ts";

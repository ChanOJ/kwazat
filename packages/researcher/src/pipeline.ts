import { and, desc, eq, uuidv7 } from "@kwazat/db";
import { entities, entityIdentifiers, facts, relations, researchCorpora, sectionRuns, type Db, type Source } from "@kwazat/db";
import { cacheTtls, purgeExpired, type PageFetcher } from "./cache.ts";
import { findEntityByIdentifier, setEntityNames, wikidataCandidates } from "./names.ts";
import {
  addUsage,
  emptyUsage,
  extract,
  normalizeUrl,
  research,
  subjectBlock,
  type ExtractedFact,
  type ExtractedSource,
  type RunConfig,
  type SubjectContext,
  type Usage,
} from "./claude.ts";
import {
  defaultFetcher,
  gatherCorpus,
  hydrateCorpus,
  notesFromDocs,
  type CorpusDoc,
  type ResearchDeps,
  type StageUsage,
} from "./research.ts";
import { corpusKey, gatherHash, notesHash, notesKey, researchHash, sectionHash, type Playbook, type ResearchSection } from "./playbook.ts";
import type { SearchProvider } from "./search/index.ts";
import { confidenceCap, lookupSource, minConfidence, selectSources, type Registry } from "./sources.ts";
import { getBandIdentity, getPersonIdentity, type Candidate, type EntityKind } from "./wikidata.ts";

export type Entity = typeof entities.$inferSelect;

export type Resolution =
  | { kind: "resolved"; wikidataId: string }
  | { kind: "ambiguous"; candidates: Candidate[] }
  | { kind: "not_found" };

/**
 * Turns a free-text query into a single Wikidata item. A Q-id is taken as is.
 * With several candidates the caller must pick one (homonym protection).
 * Candidate lists are cached (see names.ts).
 */
export async function resolve(db: Db, playbook: Playbook, query: string, pick?: number): Promise<Resolution> {
  if (/^Q\d+$/.test(query.trim())) return { kind: "resolved", wikidataId: query.trim() };
  const candidates = await wikidataCandidates(db, query, { kinds: [playbook.entity_type as EntityKind] });
  if (!candidates.length) return { kind: "not_found" };
  if (pick !== undefined) {
    const chosen = candidates[pick - 1];
    if (!chosen) throw new Error(`--pick ${pick} is out of range (1..${candidates.length})`);
    return { kind: "resolved", wikidataId: chosen.wikidataId };
  }
  if (candidates.length === 1) return { kind: "resolved", wikidataId: candidates[0]!.wikidataId };
  return { kind: "ambiguous", candidates };
}

/** Creates or refreshes a person from Wikidata (see upsertEntity). */
export const upsertPerson = (db: Db, wikidataId: string) => upsertEntity(db, wikidataId, "person");

/**
 * Creates or refreshes a person or a music group from Wikidata: entity (Kwazat id), Wikidata
 * identifier, searchable names, and deterministic Wikidata relations (family and party for
 * people, members for bands).
 */
export async function upsertEntity(db: Db, wikidataId: string, kind: EntityKind): Promise<Entity> {
  const person = kind === "band" ? await getBandIdentity(wikidataId) : await getPersonIdentity(wikidataId);
  const existing = await findEntityByIdentifier(db, "wikidata", wikidataId);
  return db.transaction(async (tx) => {
    const values = {
      type: kind,
      label: person.label,
      description: person.description,
      aliases: person.aliases,
      identity: person.identity,
      updatedAt: new Date(),
    };
    const [entity] = existing
      ? await tx.update(entities).set(values).where(eq(entities.id, existing.id)).returning()
      : await tx.insert(entities).values({ id: uuidv7(), ...values }).returning();
    if (!entity) throw new Error("Entity upsert failed");
    if (!existing) {
      await tx.insert(entityIdentifiers).values({ entityId: entity.id, scheme: "wikidata", value: wikidataId, source: "wikidata" });
    }
    await setEntityNames(tx, entity.id, person.names);

    await tx.delete(relations).where(and(eq(relations.fromEntityId, entity.id), eq(relations.origin, "wikidata")));
    if (person.relations.length) {
      await tx.insert(relations).values(
        person.relations.map((r) => ({
          fromEntityId: entity.id,
          toLabel: r.toLabel,
          toWikidataId: r.toWikidataId,
          relationType: r.relationType,
          strength: r.strength,
          description: [r.from && `from ${r.from}`, r.to && `to ${r.to}`].filter(Boolean).join(" ") || null,
          sources: [
            {
              url: person.identity.wikidataUrl,
              outlet: "Wikidata",
              publishedAt: null,
              quote: null,
              verified: true,
            },
          ],
          origin: "wikidata",
          reviewStatus: "published" as const,
        })),
      );
    }
    return entity;
  });
}

/** ISO country codes of an entity, used to pick its national sources. */
export function countryCodesOf(entity: Entity): string[] {
  return (entity.identity as { countryCodes?: string[] }).countryCodes ?? [];
}

/** Wikidata id of an entity built from Wikidata (kept in its identity block). */
export function wikidataIdOf(entity: Entity): string | null {
  const url = (entity.identity as { wikidataUrl?: string }).wikidataUrl;
  return url?.match(/(Q\d+)$/)?.[1] ?? null;
}

export function subjectOf(entity: Entity): SubjectContext {
  const id = entity.identity as {
    birthDate?: string;
    occupations?: string[];
    nationalities?: string[];
    genres?: string[];
  };
  return {
    label: entity.label,
    wikidataId: wikidataIdOf(entity),
    description: entity.description,
    kind: entity.type === "band" ? "band" : "person",
    birthDate: id.birthDate ?? null,
    occupations: id.occupations ?? [],
    nationalities: id.nationalities ?? [],
    genres: id.genres ?? [],
  };
}

/**
 * Research notes of an earlier run of this section that are still valid: same research hash
 * (nothing that shapes the research changed) and younger than the section's validity period.
 * Lets a change to the extraction alone (schema, severity ladder, extraction prompt) be applied
 * without searching the web again.
 */
export async function findReusableNotes(
  db: Db,
  entityId: string,
  section: ResearchSection,
  hash: string,
  now = new Date(),
): Promise<{ notes: string; retrievedUrls: string[] } | null> {
  const rows = await db
    .select()
    .from(sectionRuns)
    .where(and(eq(sectionRuns.entityId, entityId), eq(sectionRuns.sectionId, section.id), eq(sectionRuns.status, "succeeded")))
    .orderBy(desc(sectionRuns.startedAt));
  const reusable = rows.find(
    (r) => r.researchHash === hash && r.researchNotes && r.finishedAt && (now.getTime() - r.finishedAt.getTime()) / 86_400_000 < section.ttl_days,
  );
  return reusable ? { notes: reusable.researchNotes!, retrievedUrls: reusable.retrievedUrls } : null;
}

export type StoredCorpus = { id: string; docs: CorpusDoc[]; createdAt: Date };

/**
 * The corpus gathered earlier for this section of this entity. With a hash: the latest one with
 * this corpus key, younger than the section's validity period. Without (frozen corpus, dev
 * replay): the latest one whatever its key and age.
 */
export async function findCorpus(
  db: Db,
  entityId: string,
  section: ResearchSection,
  hash: string | null,
  now = new Date(),
): Promise<StoredCorpus | null> {
  const rows = await db
    .select()
    .from(researchCorpora)
    .where(and(eq(researchCorpora.entityId, entityId), eq(researchCorpora.sectionId, section.id)))
    .orderBy(desc(researchCorpora.createdAt));
  const row = hash === null
    ? rows[0]
    : rows.find((r) => r.corpusHash === hash && (now.getTime() - r.createdAt.getTime()) / 86_400_000 < section.ttl_days);
  return row ? { id: row.id, docs: row.docs as CorpusDoc[], createdAt: row.createdAt } : null;
}

/** A band's members from Wikidata, with their membership dates when known ("Name (from 1994 to 2000)"). */
export async function memberLines(db: Db, entityId: string): Promise<string[]> {
  const rows = await db
    .select({ label: relations.toLabel, description: relations.description })
    .from(relations)
    .where(and(eq(relations.fromEntityId, entityId), eq(relations.relationType, "has_member"), eq(relations.origin, "wikidata")));
  return rows.map((r) => (r.description ? `${r.label} (${r.description})` : r.label));
}

export type SectionOutcome =
  | { status: "skipped"; reason: string }
  | {
      status: "succeeded";
      facts: number;
      relations: number;
      needsReview: number;
      usage: Usage;
      durationMs: number;
      /** Research notes of an earlier run were reused: only the extraction was paid. */
      notesReused?: boolean;
      /** The gathered corpus (search results, pages) of an earlier run was reused. */
      corpusReused?: boolean;
    }
  | { status: "failed"; error: string; usage: Usage; durationMs: number };

export type RunSectionOptions = {
  /** Re-run notes and extraction even when the section is up to date (the corpus is still reused). */
  force?: boolean;
  /** Dev replay: reuse the latest stored corpus whatever its key; never call the planner or the search provider. */
  frozenCorpus?: boolean;
  /** Gather the corpus again, bypassing the search and page caches (implies force). */
  refreshCorpus?: boolean;
  /** Test seams (offline provider and fetcher). */
  provider?: SearchProvider;
  fetcher?: PageFetcher;
  log?: (line: string) => void;
};

/**
 * Runs one research section for an entity, unless a fresh result with the same hash exists.
 * With a search provider, each layer is reused when its key is unchanged (see playbook.ts):
 * the corpus (plan, search, triage, fetch), then the notes, and only what changed is paid.
 */
export async function runSection(
  db: Db,
  entity: Entity,
  playbook: Playbook,
  section: ResearchSection,
  config: RunConfig,
  registry: Registry,
  opts: RunSectionOptions = {},
): Promise<SectionOutcome> {
  if (opts.frozenCorpus && opts.refreshCorpus) throw new Error("--frozen-corpus and --refresh-corpus are exclusive");
  const sources = selectSources(registry, {
    countryCodes: countryCodesOf(entity),
    types: section.source_types,
    sensitive: section.sensitive,
    mode: config.sourceMode,
    skipUnreachable: config.searchProvider === "anthropic",
  });
  const hash = sectionHash(playbook, section, config, sources);
  const researchKey = researchHash(playbook, section, config, sources);

  if (!opts.force && !opts.refreshCorpus) {
    const [current] = await db
      .select()
      .from(sectionRuns)
      .where(
        and(eq(sectionRuns.entityId, entity.id), eq(sectionRuns.sectionId, section.id), eq(sectionRuns.isCurrent, true)),
      );
    if (current && current.sectionHash === hash && current.finishedAt) {
      const ageDays = (Date.now() - current.finishedAt.getTime()) / 86_400_000;
      if (ageDays < section.ttl_days) return { status: "skipped", reason: "up to date" };
    }
  }

  const started = Date.now();
  const [run] = await db
    .insert(sectionRuns)
    .values({
      entityId: entity.id,
      playbookId: playbook.id,
      playbookVersion: playbook.version,
      sectionId: section.id,
      sectionHash: hash,
      model: `${config.researchModel}+${config.extractModel}`,
    })
    .returning();
  if (!run) throw new Error("Could not create section run");

  let usage = emptyUsage();
  let stages: StageUsage = {};
  try {
    const subject = subjectOf(entity);
    if (entity.type === "band") subject.members = await memberLines(db, entity.id);
    let notesReuseKey = researchKey;
    let corpusReused = false;
    let found: { notes: string; retrievedUrls: string[]; usage: Usage };
    let notesReused = false;
    if (config.searchProvider === "anthropic") {
      // Claude's own web tools: search and notes in one call, reused as a whole.
      const reused = opts.force ? null : await findReusableNotes(db, entity.id, section, researchKey);
      found = reused ? { ...reused, usage: emptyUsage() } : await research(playbook, section, subject, config, sources);
      notesReused = !!reused;
      if (!reused) stages.research = found.usage;
    } else {
      const ttls = cacheTtls();
      await purgeExpired(db, ttls);
      const deps: ResearchDeps = {
        db,
        ttls,
        provider: opts.provider,
        fetcher: opts.fetcher ?? defaultFetcher(registry),
        refresh: opts.refreshCorpus,
        log: opts.log,
      };
      // 1. Corpus: reused unless what shapes the queries changed (or a rebuild is asked).
      const key = corpusKey(gatherHash(playbook, section, config, sources), subjectBlock(subject));
      let corpus = opts.refreshCorpus ? null : await findCorpus(db, entity.id, section, opts.frozenCorpus ? null : key);
      corpusReused = !!corpus;
      if (!corpus) {
        if (opts.frozenCorpus) {
          throw new Error("no stored corpus for this section: run once without --frozen-corpus (or with --refresh-corpus)");
        }
        const gathered = await gatherCorpus(section, subject, config, sources, registry, deps);
        stages = { ...stages, ...gathered.stages };
        const gatherUsage = Object.values(gathered.stages).reduce(addUsage, emptyUsage());
        usage = addUsage(usage, gatherUsage);
        const [row] = await db
          .insert(researchCorpora)
          .values({ entityId: entity.id, sectionId: section.id, corpusHash: key, docs: gathered.docs, usage: { ...gatherUsage, stages: gathered.stages } })
          .returning();
        if (!row) throw new Error("Could not store the corpus");
        corpus = { id: row.id, docs: gathered.docs, createdAt: row.createdAt };
      }
      // 2. Notes: reused unless the instructions, style or corpus changed.
      notesReuseKey = notesKey(notesHash(playbook, section, config), corpus.id);
      const reused = opts.force || opts.refreshCorpus ? null : await findReusableNotes(db, entity.id, section, notesReuseKey);
      if (reused) {
        found = { ...reused, usage: emptyUsage() };
        notesReused = true;
      } else {
        const docs = await hydrateCorpus(corpus.docs, registry, deps);
        const notes = await notesFromDocs(playbook, section, subject, sources, docs, config);
        stages = { ...stages, ...notes.stages };
        found = notes;
      }
      if (!opts.log) process.stderr.write("\n  ");
    }
    usage = addUsage(usage, found.usage);
    const extracted = await extract(section, subject, found.notes, found.retrievedUrls, config);
    usage = addUsage(usage, extracted.usage);
    stages.extraction = extracted.usage;

    const retrieved = new Set(found.retrievedUrls);
    const toSources = (sources: ExtractedSource[]): Source[] =>
      sources.map((s) => ({
        url: s.url,
        outlet: s.outlet,
        publishedAt: s.published_at,
        quote: s.quote,
        verified: retrieved.has(normalizeUrl(s.url)),
        tier: lookupSource(registry, s.url)?.tier ?? null,
      }));
    // The model's confidence, capped by the best verified source tier (see sources/README.md).
    const confidenceOf = (claimed: ExtractedFact["confidence"], sources: Source[]) =>
      minConfidence(claimed, confidenceCap(registry, sources.filter((s) => s.verified).map((s) => s.url)));
    // Sensitive sections and items without a verified source are held for human review.
    const statusFor = (sources: Source[]) =>
      section.sensitive || !sources.some((s) => s.verified) ? ("needs_review" as const) : ("published" as const);

    const factRows = extracted.facts.map((f) => {
      const sources = toSources(f.sources);
      return {
        entityId: entity.id,
        sectionRunId: run.id,
        sectionId: section.id,
        statement: f.statement,
        factDate: f.fact_date,
        data: f.data,
        sources,
        confidence: confidenceOf(f.confidence, sources),
        reviewStatus: statusFor(sources),
      };
    });
    const relationRows = extracted.relations.map((r) => {
      const sources = toSources(r.sources);
      return {
        fromEntityId: entity.id,
        toLabel: r.target_name,
        relationType: r.relation_type,
        strength: r.strength,
        sharePct: r.share_pct === null ? null : String(r.share_pct),
        description: r.description,
        sources,
        origin: "research",
        sectionRunId: run.id,
        reviewStatus: statusFor(sources),
      };
    });

    await db.transaction(async (tx) => {
      await tx
        .update(sectionRuns)
        .set({ isCurrent: false })
        .where(and(eq(sectionRuns.entityId, entity.id), eq(sectionRuns.sectionId, section.id)));
      if (factRows.length) await tx.insert(facts).values(factRows);
      if (relationRows.length) await tx.insert(relations).values(relationRows);
      await tx
        .update(sectionRuns)
        .set({
          status: "succeeded",
          isCurrent: true,
          researchNotes: found.notes,
          retrievedUrls: found.retrievedUrls,
          researchHash: notesReuseKey,
          notesReused,
          usage: { ...usage, stages },
          costUsd: usage.costUsd.toFixed(4),
          finishedAt: new Date(),
        })
        .where(eq(sectionRuns.id, run.id));
    });

    const needsReview = [...factRows, ...relationRows].filter((r) => r.reviewStatus === "needs_review").length;
    return {
      status: "succeeded",
      facts: factRows.length,
      relations: relationRows.length,
      needsReview,
      usage,
      durationMs: Date.now() - started,
      notesReused,
      corpusReused,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await db
      .update(sectionRuns)
      .set({ status: "failed", error, usage: { ...usage, stages }, costUsd: usage.costUsd.toFixed(4), finishedAt: new Date() })
      .where(eq(sectionRuns.id, run.id));
    return { status: "failed", error, usage, durationMs: Date.now() - started };
  }
}

/** Loads the current sheet of an entity: identity, current facts per section, relations. */
export async function loadSheet(db: Db, entityId: string) {
  const [entity] = await db.select().from(entities).where(eq(entities.id, entityId));
  if (!entity) throw new Error(`Unknown entity ${entityId}`);
  const runs = await db
    .select()
    .from(sectionRuns)
    .where(and(eq(sectionRuns.entityId, entityId), eq(sectionRuns.isCurrent, true)));
  const currentRunIds = new Set(runs.map((r) => r.id));
  const allFacts = await db.select().from(facts).where(eq(facts.entityId, entityId));
  const allRelations = await db.select().from(relations).where(eq(relations.fromEntityId, entityId));
  return {
    entity,
    runs,
    facts: allFacts.filter((f) => currentRunIds.has(f.sectionRunId)),
    relations: allRelations.filter((r) => r.origin === "wikidata" || (r.sectionRunId && currentRunIds.has(r.sectionRunId))),
  };
}

export async function findEntityByWikidataId(db: Db, wikidataId: string): Promise<Entity | undefined> {
  return findEntityByIdentifier(db, "wikidata", wikidataId);
}

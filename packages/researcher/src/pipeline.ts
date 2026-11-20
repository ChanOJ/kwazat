import { and, eq, uuidv7 } from "@kwazat/db";
import { entities, entityIdentifiers, facts, relations, sectionRuns, type Db, type Source } from "@kwazat/db";
import { findEntityByIdentifier, setEntityNames, wikidataCandidates } from "./names.ts";
import {
  addUsage,
  emptyUsage,
  extract,
  normalizeUrl,
  research,
  type ExtractedFact,
  type ExtractedSource,
  type RunConfig,
  type SubjectContext,
  type Usage,
} from "./claude.ts";
import { researchWithSearch } from "./research.ts";
import { sectionHash, type Playbook, type ResearchSection } from "./playbook.ts";
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
  | { status: "succeeded"; facts: number; relations: number; needsReview: number; usage: Usage; durationMs: number }
  | { status: "failed"; error: string; usage: Usage; durationMs: number };

/** Runs one research section for an entity, unless a fresh result with the same hash exists. */
export async function runSection(
  db: Db,
  entity: Entity,
  playbook: Playbook,
  section: ResearchSection,
  config: RunConfig,
  registry: Registry,
  opts: { force?: boolean } = {},
): Promise<SectionOutcome> {
  const sources = selectSources(registry, {
    countryCodes: countryCodesOf(entity),
    types: section.source_types,
    sensitive: section.sensitive,
    mode: config.sourceMode,
    skipUnreachable: config.searchProvider === "anthropic",
  });
  const hash = sectionHash(playbook, section, config, sources);

  if (!opts.force) {
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
  try {
    const subject = subjectOf(entity);
    if (entity.type === "band") subject.members = await memberLines(db, entity.id);
    const found = config.searchProvider === "anthropic"
      ? await research(playbook, section, subject, config, sources)
      : await researchWithSearch(playbook, section, subject, config, sources, registry);
    usage = addUsage(usage, found.usage);
    const extracted = await extract(section, subject, found.notes, found.retrievedUrls, config);
    usage = addUsage(usage, extracted.usage);

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
          usage,
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
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await db
      .update(sectionRuns)
      .set({ status: "failed", error, usage, costUsd: usage.costUsd.toFixed(4), finishedAt: new Date() })
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

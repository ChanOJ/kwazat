import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Source } from "@kwazat/db";
import { bandsOfMember, findEntity, knownByWikidataIds } from "@kwazat/researcher/names";
import { loadSheet, wikidataIdOf } from "@kwazat/researcher/pipeline";
import { loadPlaybook } from "@kwazat/researcher/playbook";
import { latestResearch, runningSections } from "@kwazat/researcher/worker";
import { getDb } from "@/lib/db.ts";
import { AutoRefresh } from "../../auto-refresh.tsx";
import { startResearch } from "../../research/actions.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function entityOr404(id: string) {
  if (!UUID.test(id)) notFound();
  const entity = await findEntity(await getDb(), id);
  if (!entity) notFound();
  return entity;
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const entity = await entityOr404((await params).id);
  return { title: entity.label };
}

const list = (v: unknown) => (Array.isArray(v) && v.length ? v.join(", ") : null);

export default async function EntityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const entity = await entityOr404(id);
  if (entity.id !== id) redirect(`/entity/${entity.id}`); // merged duplicate
  const [t, ts, tr, locale] = await Promise.all([getTranslations("sheet"), getTranslations("sections"), getTranslations("relations"), getLocale()]);
  const sectionTitle = (id: string, fallback: string) => (ts.has(id as never) ? ts(id as never) : fallback);
  const relationLabel = (type: string) => (tr.has(type as never) ? tr(type as never) : type.replaceAll("_", " "));
  const db = await getDb();
  const sheet = await loadSheet(db, entity.id);
  const playbook = loadPlaybook(entity.type);
  const wikidataId = wikidataIdOf(entity);
  const isBand = entity.type === "band";
  const researchType = isBand ? "band" : "person";
  const job = wikidataId ? await latestResearch(db, { type: researchType, wikidataId }) : undefined;
  const inProgress = job?.status === "queued" || job?.status === "running";
  const running = new Set(inProgress ? await runningSections(db, entity.id) : []);
  const researchSections = playbook.sections.filter((s) => s.method === "research");
  const identity = entity.identity as Record<string, unknown>;
  const facts: [string, string | null][] = isBand
    ? [
        [t("origin"), list(identity.origins)],
        [t("genres"), list(identity.genres)],
        [t("recordLabels"), list(identity.labels)],
        [t("formed"), (identity.birthDate as string) ?? null],
        [t("disbanded"), (identity.deathDate as string) ?? null],
      ]
    : [
        [t("nationality"), list(identity.nationalities)],
        [t("occupation"), list(identity.occupations)],
        [t("born"), (identity.birthDate as string) ?? null],
        [t("died"), (identity.deathDate as string) ?? null],
      ];
  const website = typeof identity.website === "string" ? identity.website : null;
  // Wikidata relations of a band are its members, shown under their own heading.
  const wikidataRelations = sheet.relations.filter((r) => r.origin === "wikidata");
  // Members with a sheet of their own link to it; a person's sheet links back to its bands.
  const memberSheets = isBand
    ? await knownByWikidataIds(db, wikidataRelations.map((r) => r.toWikidataId).filter((x): x is string => !!x))
    : new Map<string, string>();
  const bands = !isBand && wikidataId ? await bandsOfMember(db, wikidataId) : [];

  return (
    <article className="sheet">
      {inProgress && <AutoRefresh seconds={4} />}
      <header className="sheet-header">
        {typeof identity.photoUrl === "string" && (
          // Wikimedia Commons image; no referrer is sent.
          <img src={identity.photoUrl} alt="" className="portrait" referrerPolicy="no-referrer" />
        )}
        <div>
          <h1>{entity.label}</h1>
          {entity.description && (
            <p className="lead" lang="en">
              {entity.description}
            </p>
          )}
          <dl className="identity">
            {facts
              .filter(([, value]) => value)
              .map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd lang="en">{value}</dd>
                </div>
              ))}
          </dl>
          {bands.length > 0 && (
            <p className="links">
              {t("memberOf")}{" "}
              {bands.map((b) => (
                <Link key={b.entityId} href={`/entity/${b.entityId}`}>{b.label}</Link>
              ))}
            </p>
          )}
          <p className="links">
            {typeof identity.wikipediaUrl === "string" && <a href={identity.wikipediaUrl}>Wikipedia</a>}
            {website && <a href={website} rel="noreferrer">{t("website")}</a>}
          </p>
        </div>
      </header>

      {locale !== "en" && t("contentLanguage") && (
        <p className="notice" lang={locale}>
          {t("contentLanguage")}
        </p>
      )}
      {inProgress && (
        <p className="notice" aria-live="polite">
          {t("inProgress")}
        </p>
      )}
      {!inProgress && job?.status !== "failed" && wikidataId && researchSections.some((s) => !sheet.runs.some((r) => r.sectionId === s.id)) && (
        <form action={startResearch} className="notice">
          <span>{t("missing")}</span>
          <input type="hidden" name="wikidataId" value={wikidataId} />
          <input type="hidden" name="type" value={researchType} />
          <button type="submit">{t("researchThem")}</button>
        </form>
      )}
      {job?.status === "failed" && wikidataId && (
        <form action={startResearch} className="notice error">
          <span>{t("failed", { error: job.lastError ?? "" })}</span>
          <input type="hidden" name="wikidataId" value={wikidataId} />
          <input type="hidden" name="type" value={researchType} />
          <button type="submit">{(await getTranslations("research"))("tryAgain")}</button>
        </form>
      )}

      {researchSections.map((section) => {
          const run = sheet.runs.find((r) => r.sectionId === section.id);
          // Most recent first (partial dates compare as text); undated items last.
          const sectionFacts = sheet.facts
            .filter((f) => f.sectionId === section.id && f.reviewStatus !== "rejected")
            .sort((x, y) => (y.factDate ?? "").localeCompare(x.factDate ?? ""));
          const sectionRelations = sheet.relations.filter(
            (r) => r.origin !== "wikidata" && run && r.sectionRunId === run.id && r.reviewStatus !== "rejected",
          );
          const sources: Source[] = [];
          const cite = (items: Source[]) =>
            items.map((s) => {
              let n = sources.findIndex((x) => x.url === s.url) + 1;
              if (!n) n = sources.push(s);
              return (
                <sup key={s.url}>
                  <a href={`#${section.id}-src-${n}`}>[{n}]</a>
                </sup>
              );
            });
          return (
            <section key={section.id} className="sheet-section" id={section.id}>
              <h2>{sectionTitle(section.id, section.title)}</h2>
              {!run ? (
                <p className="empty">{running.has(section.id) || inProgress ? t("researching") : t("notResearched")}</p>
              ) : sectionFacts.length + sectionRelations.length === 0 ? (
                <p className="empty">{t("nothing")}</p>
              ) : (
                <ul className="facts" lang="en">
                  {sectionFacts.map((f) => (
                    <li key={f.id}>
                      {f.factDate && <span className="date">{f.factDate}</span>} {f.statement} {cite(f.sources)}
                      {f.reviewStatus === "needs_review" && <span className="badge" lang={locale}>{t("needsReview")}</span>}
                    </li>
                  ))}
                  {sectionRelations.map((r) => (
                    <li key={r.id}>
                      <span className="relation" lang={locale}>{relationLabel(r.relationType)}</span> {r.toLabel}
                      {r.description && `: ${r.description}`} {cite(r.sources)}
                      {r.reviewStatus === "needs_review" && <span className="badge" lang={locale}>{t("needsReview")}</span>}
                    </li>
                  ))}
                </ul>
              )}
              {sources.length > 0 && (
                <ol className="sources">
                  {sources.map((s, i) => (
                    <li key={s.url} id={`${section.id}-src-${i + 1}`}>
                      <a href={s.url} rel="noreferrer">
                        {s.outlet}
                      </a>
                      {s.publishedAt && `, ${s.publishedAt}`}
                      {!s.verified && ` ${t("unverified")}`}
                    </li>
                  ))}
                </ol>
              )}
            </section>
          );
        })}

      {wikidataRelations.length > 0 && (
        <section className="sheet-section">
          <h2>{isBand ? t("members") : t("wikidataRelations")}</h2>
          <ul className="facts" lang="en">
            {wikidataRelations.map((r) => (
              <li key={r.id}>
                {!isBand && <><span className="relation" lang={locale}>{relationLabel(r.relationType)}</span>{" "}</>}
                {isBand && r.toWikidataId && memberSheets.get(r.toWikidataId) ? (
                  <Link href={`/entity/${memberSheets.get(r.toWikidataId)}`}>{r.toLabel}</Link>
                ) : (
                  r.toLabel
                )}
                {r.description && ` · ${r.description}`}
                {isBand && r.toWikidataId && !memberSheets.has(r.toWikidataId) && (
                  // A button, not a link: research is paid and must never start from a prefetch.
                  <form action={startResearch} className="inline-form">
                    <input type="hidden" name="wikidataId" value={r.toWikidataId} />
                    <input type="hidden" name="type" value="person" />
                    <button type="submit" className="link-button" aria-label={`${t("researchMember")}: ${r.toLabel}`}>{t("researchMember")}</button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {typeof identity.wikidataUrl === "string" && (
        <p className="provenance">
          {t.rich("identitySource", { link: (chunks) => <a href={identity.wikidataUrl as string}>{chunks}</a> })}
        </p>
      )}
    </article>
  );
}

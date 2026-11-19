import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import type { Source } from "@kwazat/db";
import { findEntity } from "@kwazat/researcher/names";
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
  const db = await getDb();
  const sheet = await loadSheet(db, entity.id);
  const playbook = loadPlaybook(entity.type);
  const wikidataId = wikidataIdOf(entity);
  const job = wikidataId ? await latestResearch(db, { type: "person", wikidataId }) : undefined;
  const inProgress = job?.status === "queued" || job?.status === "running";
  const running = new Set(inProgress ? await runningSections(db, entity.id) : []);
  const researchSections = playbook.sections.filter((s) => s.method === "research");
  const identity = entity.identity as Record<string, unknown>;
  const facts: [string, string | null][] = [
    ["Nationality", list(identity.nationalities)],
    ["Occupation", list(identity.occupations)],
    ["Born", (identity.birthDate as string) ?? null],
    ["Died", (identity.deathDate as string) ?? null],
  ];

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
          {entity.description && <p className="lead">{entity.description}</p>}
          <dl className="identity">
            {facts
              .filter(([, value]) => value)
              .map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
          </dl>
          <p className="links">
            {typeof identity.wikipediaUrl === "string" && <a href={identity.wikipediaUrl}>Wikipedia</a>}
            {typeof identity.wikidataUrl === "string" && <a href={identity.wikidataUrl}>Wikidata</a>}
          </p>
        </div>
      </header>

      {inProgress && (
        <p className="notice" aria-live="polite">
          Research in progress: sections appear as they are done.
        </p>
      )}
      {!inProgress && job?.status !== "failed" && wikidataId && researchSections.some((s) => !sheet.runs.some((r) => r.sectionId === s.id)) && (
        <form action={startResearch} className="notice">
          <span>Some sections have not been researched yet.</span>
          <input type="hidden" name="wikidataId" value={wikidataId} />
          <button type="submit">Research them</button>
        </form>
      )}
      {job?.status === "failed" && wikidataId && (
        <form action={startResearch} className="notice error">
          <span>Research failed: {job.lastError}</span>
          <input type="hidden" name="wikidataId" value={wikidataId} />
          <button type="submit">Try again</button>
        </form>
      )}

      {researchSections.map((section) => {
          const run = sheet.runs.find((r) => r.sectionId === section.id);
          const sectionFacts = sheet.facts.filter((f) => f.sectionId === section.id && f.reviewStatus !== "rejected");
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
              <h2>{section.title}</h2>
              {!run ? (
                <p className="empty">{running.has(section.id) || inProgress ? "Researching…" : "Not researched yet."}</p>
              ) : sectionFacts.length + sectionRelations.length === 0 ? (
                <p className="empty">Nothing found.</p>
              ) : (
                <ul className="facts">
                  {sectionFacts.map((f) => (
                    <li key={f.id}>
                      {f.factDate && <span className="date">{f.factDate}</span>} {f.statement} {cite(f.sources)}
                      {f.reviewStatus === "needs_review" && <span className="badge">needs review</span>}
                    </li>
                  ))}
                  {sectionRelations.map((r) => (
                    <li key={r.id}>
                      <span className="relation">{r.relationType.replaceAll("_", " ")}</span> {r.toLabel}
                      {r.description && `: ${r.description}`} {cite(r.sources)}
                      {r.reviewStatus === "needs_review" && <span className="badge">needs review</span>}
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
                      {!s.verified && " (unverified)"}
                    </li>
                  ))}
                </ol>
              )}
            </section>
          );
        })}

      {sheet.relations.some((r) => r.origin === "wikidata") && (
        <section className="sheet-section">
          <h2>Relations (Wikidata)</h2>
          <ul className="facts">
            {sheet.relations
              .filter((r) => r.origin === "wikidata")
              .map((r) => (
                <li key={r.id}>
                  <span className="relation">{r.relationType.replaceAll("_", " ")}</span> {r.toLabel}
                  {r.description && ` · ${r.description}`}
                </li>
              ))}
          </ul>
        </section>
      )}
    </article>
  );
}

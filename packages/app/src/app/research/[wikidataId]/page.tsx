import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { findEntityByIdentifier } from "@kwazat/researcher/names";
import { latestResearch } from "@kwazat/researcher/worker";
import { getDb } from "@/lib/db.ts";
import { AutoRefresh } from "../../auto-refresh.tsx";
import { startResearch } from "../actions.ts";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("meta"))("researching") };
}

/** Waiting page until the subject's identity is known; the sheet page then shows the rest. */
export default async function ResearchPage({ params }: { params: Promise<{ wikidataId: string }> }) {
  const { wikidataId } = await params;
  if (!/^Q[1-9][0-9]{0,11}$/.test(wikidataId)) notFound();
  const t = await getTranslations("research");
  const db = await getDb();
  const entity = await findEntityByIdentifier(db, "wikidata", wikidataId);
  if (entity) redirect(`/entity/${entity.id}`);
  // The subject is a person or a band: the job tells which.
  const jobs = await Promise.all((["person", "band"] as const).map((type) => latestResearch(db, { type, wikidataId })));
  const job = jobs.filter((j) => !!j).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (!job) notFound();
  const type = (job.payload as { type?: string }).type === "band" ? "band" : "person";

  if (job.status === "failed") {
    return (
      <section>
        <h1>{t("failedTitle")}</h1>
        <p className="error">{job.lastError}</p>
        <form action={startResearch}>
          <input type="hidden" name="wikidataId" value={wikidataId} />
          <input type="hidden" name="type" value={type} />
          <button type="submit">{t("tryAgain")}</button>
        </form>
      </section>
    );
  }
  return (
    <section className="waiting" aria-live="polite">
      <AutoRefresh />
      <h1>{t("waitingTitle")}</h1>
      <p className="lead">{t("waitingLead")}</p>
      <div className="spinner" aria-hidden="true" />
    </section>
  );
}

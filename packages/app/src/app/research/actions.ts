"use server";

import { redirect } from "next/navigation";
import { findEntityByIdentifier } from "@kwazat/researcher/names";
import { queueResearch } from "@kwazat/researcher/worker";
import { getDb } from "@/lib/db.ts";

const WIKIDATA_ID = /^Q[1-9][0-9]{0,11}$/;

/** Queues research of a subject (person or band) Kwazat does not know yet (paid), then shows the waiting page. */
export async function startResearch(formData: FormData): Promise<void> {
  const wikidataId = String(formData.get("wikidataId") ?? "");
  if (!WIKIDATA_ID.test(wikidataId)) redirect("/");
  const type = formData.get("type") === "band" ? "band" : "person";
  const db = await getDb();
  await queueResearch(db, { type, wikidataId });
  const entity = await findEntityByIdentifier(db, "wikidata", wikidataId);
  redirect(entity ? `/entity/${entity.id}` : `/research/${wikidataId}`);
}

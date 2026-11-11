import type { loadSheet } from "./pipeline.ts";
import type { Playbook } from "./playbook.ts";

type Sheet = Awaited<ReturnType<typeof loadSheet>>;

/**
 * Renders a sheet as Markdown, Kagi News-style: each section lists neutral statements with
 * numbered citations, followed by the list of sources.
 */
export function renderSheet(sheet: Sheet, playbook: Playbook, opts: { includeUnreviewed: boolean }): string {
  const { entity } = sheet;
  const id = entity.identity as Record<string, unknown>;
  const lines: string[] = [];
  const list = (v: unknown) => (Array.isArray(v) && v.length ? v.join(", ") : "—");

  lines.push(`# ${entity.label}`, "");
  if (entity.description) lines.push(`_${entity.description}_`, "");
  lines.push(
    `- Gender: ${id.gender ?? "—"}`,
    `- Nationality: ${list(id.nationalities)}`,
    `- Occupation: ${list(id.occupations)}`,
    `- Born: ${id.birthDate ?? "—"}${id.deathDate ? ` · Died: ${id.deathDate}` : ""}`,
    `- Photo: ${id.photoUrl ?? "—"}`,
    `- Wikipedia: ${id.wikipediaUrl ?? "—"} · Wikidata: ${id.wikidataUrl ?? "—"}`,
    "",
  );

  const visible = <T extends { reviewStatus: string }>(rows: T[]) =>
    rows.filter((r) => r.reviewStatus === "published" || (opts.includeUnreviewed && r.reviewStatus === "needs_review"));
  const flag = (status: string) => (status === "needs_review" ? " ⚠️ _needs review_" : "");

  for (const section of playbook.sections) {
    if (section.method !== "research") continue;
    const run = sheet.runs.find((r) => r.sectionId === section.id);
    lines.push(`## ${section.title}`, "");
    if (!run) {
      lines.push("_Not researched yet._", "");
      continue;
    }

    const sources: string[] = [];
    const cite = (urls: { url: string; outlet: string; publishedAt: string | null; verified: boolean }[]) =>
      urls
        .map((s) => {
          let n = sources.findIndex((x) => x.startsWith(`${s.url} `)) + 1;
          if (!n) {
            sources.push(`${s.url} — ${s.outlet}${s.publishedAt ? `, ${s.publishedAt}` : ""}${s.verified ? "" : " (unverified)"}`);
            n = sources.length;
          }
          return `[${n}]`;
        })
        .join("");

    const sectionFacts = visible(sheet.facts.filter((f) => f.sectionId === section.id));
    const sectionRelations = visible(
      sheet.relations.filter((r) => r.origin !== "wikidata" && r.sectionRunId === run.id),
    );
    if (!sectionFacts.length && !sectionRelations.length) lines.push("_Nothing found._");
    for (const f of sectionFacts) {
      lines.push(`- ${f.factDate ? `**${f.factDate}** · ` : ""}${f.statement} ${cite(f.sources)}${flag(f.reviewStatus)}`);
    }
    for (const r of sectionRelations) {
      lines.push(`- **${r.relationType}** → ${r.toLabel} (strength ${r.strength}): ${r.description ?? ""} ${cite(r.sources)}${flag(r.reviewStatus)}`);
    }
    if (sources.length) {
      lines.push("", "Sources:");
      sources.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    }
    lines.push("", `_Researched ${run.finishedAt?.toISOString().slice(0, 10) ?? "?"} · ${run.model} · $${run.costUsd ?? "?"}_`, "");
  }

  const wikidataRelations = sheet.relations.filter((r) => r.origin === "wikidata");
  if (wikidataRelations.length) {
    lines.push("## Relations (Wikidata)", "");
    for (const r of wikidataRelations) {
      lines.push(`- **${r.relationType}** → ${r.toLabel}${r.toWikidataId ? ` (${r.toWikidataId})` : ""}${r.description ? ` · ${r.description}` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

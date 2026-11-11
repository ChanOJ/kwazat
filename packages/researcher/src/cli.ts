import { parseArgs } from "node:util";
import { openDb } from "@waza/db";
import { DEFAULT_MODEL, addUsage, emptyUsage } from "./claude.ts";
import { runEval } from "./eval.ts";
import { loadPlaybook, type ResearchSection } from "./playbook.ts";
import { findEntityByWikidataId, loadSheet, resolve, runSection, upsertPerson } from "./pipeline.ts";
import { renderSheet } from "./sheet.ts";

const USAGE = `Usage:
  research <name|Q-id> [--type person] [--pick N] [--sections a,b] [--force] [--model M] [--identity-only]
  sheet <name|Q-id> [--type person] [--pick N] [--all]
  eval [person] [--only "Name"] [--sections a,b] [--model M]`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    type: { type: "string", default: "person" },
    pick: { type: "string" },
    sections: { type: "string" },
    force: { type: "boolean", default: false },
    model: { type: "string" },
    "identity-only": { type: "boolean", default: false },
    all: { type: "boolean", default: false },
    only: { type: "string" },
  },
});

const [command, ...rest] = positionals;
const query = rest.join(" ").trim();
const model = values.model ?? process.env.WAZA_MODEL ?? DEFAULT_MODEL;
const sectionFilter = values.sections?.split(",").map((s) => s.trim());

function selectSections(playbookSections: ReturnType<typeof loadPlaybook>["sections"]): ResearchSection[] {
  const research = playbookSections.filter((s): s is ResearchSection => s.method === "research");
  if (!sectionFilter) return research;
  const unknown = sectionFilter.filter((id) => !research.some((s) => s.id === id));
  if (unknown.length) throw new Error(`Unknown section(s): ${unknown.join(", ")}`);
  return research.filter((s) => sectionFilter.includes(s.id));
}

async function resolveOrExit(playbook: ReturnType<typeof loadPlaybook>) {
  if (!query) throw new Error(USAGE);
  const result = await resolve(playbook, query, values.pick ? Number(values.pick) : undefined);
  if (result.kind === "not_found") {
    console.error(`No ${playbook.label.toLowerCase()} found for "${query}".`);
    process.exit(1);
  }
  if (result.kind === "ambiguous") {
    console.error(`Several matches for "${query}". Re-run with --pick N:`);
    result.candidates.forEach((c, i) =>
      console.error(`  ${i + 1}. ${c.label} (${c.wikidataId}) — ${c.description ?? "no description"}${c.birthDate ? `, born ${c.birthDate}` : ""}`),
    );
    process.exit(2);
  }
  return result.wikidataId;
}

async function main() {
  if (command === "eval") {
    await runEval(rest[0] ?? "person", { model, only: values.only, sections: sectionFilter });
    return;
  }
  if (command !== "research" && command !== "sheet") throw new Error(USAGE);

  const playbook = loadPlaybook(values.type);
  if (playbook.entity_type !== "person") throw new Error(`Playbook "${playbook.id}" is not supported yet`);
  const wikidataId = await resolveOrExit(playbook);
  const db = await openDb();
  try {
    if (command === "sheet") {
      const entity = await findEntityByWikidataId(db, wikidataId);
      if (!entity) {
        console.error(`No sheet yet for ${wikidataId}. Run: pnpm research ${wikidataId}`);
        process.exit(1);
      }
      console.log(renderSheet(await loadSheet(db, entity.id), playbook, { includeUnreviewed: values.all }));
      return;
    }

    console.error(`Resolving identity from Wikidata (${wikidataId})...`);
    const entity = await upsertPerson(db, wikidataId);
    console.error(`→ ${entity.label}: ${entity.description ?? ""}`);
    if (!values["identity-only"]) {
      let total = emptyUsage();
      for (const section of selectSections(playbook.sections)) {
        process.stderr.write(`  ${section.id}... `);
        const outcome = await runSection(db, entity, playbook, section, model, { force: values.force });
        if (outcome.status === "skipped") console.error(`skipped (${outcome.reason})`);
        else if (outcome.status === "failed") console.error(`FAILED: ${outcome.error}`);
        else
          console.error(
            `${outcome.facts} facts, ${outcome.relations} relations (${outcome.needsReview} to review) · ` +
              `${outcome.usage.webSearches} searches · $${outcome.usage.costUsd.toFixed(3)} · ${(outcome.durationMs / 1000).toFixed(0)}s`,
          );
        if (outcome.status !== "skipped") total = addUsage(total, outcome.usage);
      }
      console.error(`Total estimated cost: $${total.costUsd.toFixed(3)}`);
    }
    console.log(renderSheet(await loadSheet(db, entity.id), playbook, { includeUnreviewed: true }));
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

import { parseArgs } from "node:util";
import { openDb } from "@kwazat/db";
import { addUsage, describeConfig, emptyUsage, formatCost, resolveConfig } from "./claude.ts";
import { runEval } from "./eval.ts";
import { updateIndices } from "./indices.ts";
import { checkAccess } from "./access.ts";
import { loadPlaybook, type ResearchSection } from "./playbook.ts";
import { countryCodesOf, findEntityByWikidataId, loadSheet, resolve, runSection, upsertPerson } from "./pipeline.ts";
import { loadRegistry, selectSources } from "./sources.ts";
import { renderSheet } from "./sheet.ts";

const RUN_OPTIONS =
  "[--research-model M] [--extract-model M] [--effort low|medium|high] [--max-searches N] [--max-fetches N] [--source-mode auto|restricted|preferred] [--search-provider brave|brave-context|anthropic]";
const USAGE = `Usage:
  research <name|Q-id> [--type person] [--pick N] [--sections a,b] [--force] [--identity-only] ${RUN_OPTIONS}
  sheet <name|Q-id> [--type person] [--pick N] [--all]
  sources <name|Q-id> [--type person] [--pick N] [--sections a,b]
  indices                      (downloads country indices into sources/countries.json)
  reach                        (lists registry domains the web tools cannot reach)
  eval [person] [--only "Name"] [--sections a,b] ${RUN_OPTIONS}`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    type: { type: "string", default: "person" },
    pick: { type: "string" },
    sections: { type: "string" },
    force: { type: "boolean", default: false },
    "research-model": { type: "string" },
    "extract-model": { type: "string" },
    effort: { type: "string" },
    "max-searches": { type: "string" },
    "max-fetches": { type: "string" },
    "source-mode": { type: "string" },
    "search-provider": { type: "string" },
    "identity-only": { type: "boolean", default: false },
    all: { type: "boolean", default: false },
    only: { type: "string" },
  },
});

const [command, ...rest] = positionals;
const query = rest.join(" ").trim();
const config = resolveConfig({
  researchModel: values["research-model"],
  extractModel: values["extract-model"],
  researchEffort: values.effort,
  maxSearches: values["max-searches"],
  maxFetches: values["max-fetches"],
  sourceMode: values["source-mode"],
  searchProvider: values["search-provider"],
});
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

/** Fails early with a hint instead of letting every section fail on authentication. */
function assertApiKey() {
  if (config.searchProvider.startsWith("brave") && !process.env.BRAVE_SEARCH_API_KEY) {
    throw new Error(
      "BRAVE_SEARCH_API_KEY is not set. Create a key at https://api-dashboard.search.brave.com, store it in Proton " +
        "Pass (vault Waza, item brave-search-api-key) and uncomment its line in secrets.env, or use --search-provider anthropic.",
    );
  }
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return;
  throw new Error(
    "ANTHROPIC_API_KEY is not set. Run through the root scripts (pnpm research / pnpm eval), which inject it " +
      "from Proton Pass via secrets.env, or export it in CI from the repository secrets.",
  );
}

async function main() {
  if (command === "eval") {
    assertApiKey();
    await runEval(rest[0] ?? "person", { config, only: values.only, sections: sectionFilter });
    return;
  }
  if (command === "reach") {
    assertApiKey();
    const domains = [...loadRegistry().files.values()].flatMap((f) => f.sources.map((s) => s.domain));
    const file = await checkAccess(domains);
    console.log(`${file.blocked.length} of ${domains.length} registry domains are not reachable by the web tools:`);
    console.log(file.blocked.map((d) => `  ${d}`).join("\n"));
    return;
  }
  if (command === "indices") {
    const file = await updateIndices();
    console.log(`Updated ${Object.keys(file.countries).length} countries:`);
    for (const src of file.sources) console.log(`  ${src.id} (${src.year}): ${src.url}`);
    return;
  }
  if (command !== "research" && command !== "sheet" && command !== "sources") throw new Error(USAGE);

  const playbook = loadPlaybook(values.type);
  if (playbook.entity_type !== "person") throw new Error(`Playbook "${playbook.id}" is not supported yet`);
  const wikidataId = await resolveOrExit(playbook);
  const registry = loadRegistry();
  const db = await openDb();
  try {
    if (command === "sources") {
      // Free: shows which sources each section would use for this subject (no LLM call).
      const entity = await upsertPerson(db, wikidataId);
      console.log(`${entity.label} (${wikidataId}) · countries: ${countryCodesOf(entity).join(", ") || "none on Wikidata"}`);
      for (const section of selectSections(playbook.sections)) {
        const sel = selectSources(registry, {
          countryCodes: countryCodesOf(entity),
          types: section.source_types,
          sensitive: section.sensitive,
          mode: config.sourceMode,
          skipUnreachable: config.searchProvider === "anthropic",
        });
        console.log(`\n## ${section.id}: ${sel.mode} · files ${sel.countries.join(" + ")} · ${sel.sources.length} reachable sources` +
          (sel.uncovered.length ? ` · no registry for ${sel.uncovered.join(", ")}` : ""));
        for (const c of sel.flagged) {
          if (c.ruleOfLaw.low) console.log(`  ! ${c.name} rule of law: ${c.ruleOfLaw.reasons.join("; ")}`);
          if (c.pressFreedom.low) console.log(`  ! ${c.name} press freedom: ${c.pressFreedom.reasons.join("; ")}`);
        }
        console.log(sel.sources.map((s) => `  [${s.tier ?? "-"}] ${s.domain}`).join("\n"));
      }
      console.log("\n[-] unrated: no deciding evidence yet, confidence capped at medium (see sources/README.md)");
      return;
    }
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
      assertApiKey();
      console.error(`Config: ${describeConfig(config)}`);
      let total = emptyUsage();
      for (const section of selectSections(playbook.sections)) {
        process.stderr.write(`  ${section.id}... `);
        const outcome = await runSection(db, entity, playbook, section, config, registry, { force: values.force });
        if (outcome.status === "skipped") console.error(`skipped (${outcome.reason})`);
        else if (outcome.status === "failed") console.error(`FAILED: ${outcome.error}`);
        else
          console.error(
            `${outcome.facts} facts, ${outcome.relations} relations (${outcome.needsReview} to review) · ` +
              `${formatCost(outcome.usage)} · ${(outcome.durationMs / 1000).toFixed(0)}s`,
          );
        if (outcome.status !== "skipped") total = addUsage(total, outcome.usage);
      }
      console.error(`Total estimated cost: ${formatCost(total)}`);
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

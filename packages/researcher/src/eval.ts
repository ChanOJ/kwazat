import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import { openDb } from "@waza/db";
import { addUsage, emptyUsage, type Usage } from "./claude.ts";
import { loadPlaybook, type ResearchSection } from "./playbook.ts";
import { loadSheet, resolve, runSection, upsertPerson } from "./pipeline.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const EVAL_DIR = path.resolve(here, "../../../eval");

const Check = z.object({
  section: z.string(),
  pattern: z.string().optional(),
  expect_empty: z.boolean().default(false),
  description: z.string(),
});
const Case = z.object({
  query: z.string(),
  expected_wikidata_id: z.string(),
  expect_ambiguous: z.boolean().default(false),
  checks: z.array(Check).default([]),
});
const Golden = z.object({ cases: z.array(Case) });

type CheckResult = { description: string; passed: boolean; detail: string };
type CaseResult = {
  query: string;
  resolution: { passed: boolean; detail: string };
  checks: CheckResult[];
  usage: Usage;
  failures: string[];
  durationMs: number;
};

/**
 * Runs the golden set against the current playbook in an isolated database (always re-researches),
 * then writes a Markdown report to eval/reports/.
 */
export async function runEval(
  playbookId: string,
  opts: { model: string; only?: string; sections?: string[] },
): Promise<void> {
  const playbook = loadPlaybook(playbookId);
  const golden = Golden.parse(parse(fs.readFileSync(path.join(EVAL_DIR, "golden", `${playbookId}.yaml`), "utf8")));
  const cases = golden.cases.filter((c) => !opts.only || c.query === opts.only);
  const sections = playbook.sections
    .filter((s): s is ResearchSection => s.method === "research")
    .filter((s) => !opts.sections || opts.sections.includes(s.id));

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const db = await openDb(path.resolve(here, `../../../.data/eval-${stamp}`));
  const results: CaseResult[] = [];

  try {
    for (const c of cases) {
      console.error(`\n▶ ${c.query}`);
      const started = Date.now();
      let usage = emptyUsage();
      const failures: string[] = [];

      // 1. Resolution: the expected item must be found; ambiguity must be surfaced when expected.
      const first = await resolve(playbook, c.query);
      let resolution: CaseResult["resolution"];
      if (first.kind === "resolved") {
        resolution = {
          passed: first.wikidataId === c.expected_wikidata_id && !c.expect_ambiguous,
          detail: `resolved directly to ${first.wikidataId}${c.expect_ambiguous ? " (ambiguity expected)" : ""}`,
        };
      } else if (first.kind === "ambiguous") {
        const idx = first.candidates.findIndex((x) => x.wikidataId === c.expected_wikidata_id);
        resolution = {
          passed: idx >= 0 && c.expect_ambiguous,
          detail: `${first.candidates.length} candidates, expected at position ${idx + 1 || "none"}`,
        };
      } else {
        resolution = { passed: false, detail: "not found" };
      }
      console.error(`  resolution: ${resolution.passed ? "✓" : "✗"} ${resolution.detail}`);

      // 2. Research the expected item (even if resolution failed, to still evaluate the content).
      const entity = await upsertPerson(db, c.expected_wikidata_id);
      for (const section of sections) {
        process.stderr.write(`  ${section.id}... `);
        const outcome = await runSection(db, entity, playbook, section, opts.model, { force: true });
        if (outcome.status === "skipped") continue;
        usage = addUsage(usage, outcome.usage);
        if (outcome.status === "failed") failures.push(`${section.id}: ${outcome.error}`);
        console.error(outcome.status === "failed" ? `FAILED: ${outcome.error}` : `${outcome.facts + outcome.relations} items`);
      }

      // 3. Content checks (on everything produced, including items pending review).
      const sheet = await loadSheet(db, entity.id);
      const textOf = (sectionId: string) => {
        const facts = sheet.facts.filter((f) => sectionId === "*" || f.sectionId === sectionId);
        const runIds = new Set(sheet.runs.filter((r) => sectionId === "*" || r.sectionId === sectionId).map((r) => r.id));
        const rels = sheet.relations.filter((r) => r.sectionRunId && runIds.has(r.sectionRunId));
        return {
          count: facts.length + rels.length,
          text: [
            ...facts.map((f) => `${f.statement} ${JSON.stringify(f.data)}`),
            ...rels.map((r) => `${r.relationType} ${r.toLabel} ${r.description ?? ""}`),
          ].join("\n"),
        };
      };
      const checks = c.checks
        .filter((ch) => ch.section === "*" || sections.some((s) => s.id === ch.section))
        .map((ch): CheckResult => {
          const { count, text } = textOf(ch.section);
          if (ch.expect_empty) return { description: ch.description, passed: count === 0, detail: `${count} items` };
          const passed = new RegExp(ch.pattern ?? "", "i").test(text);
          return { description: ch.description, passed, detail: passed ? "found" : `not found in ${count} items` };
        });
      checks.forEach((ch) => console.error(`  ${ch.passed ? "✓" : "✗"} ${ch.description} (${ch.detail})`));

      results.push({ query: c.query, resolution, checks, usage, failures, durationMs: Date.now() - started });
    }
  } finally {
    await db.close();
  }

  const report = renderReport(playbook.id, playbook.version, opts.model, results);
  fs.mkdirSync(path.join(EVAL_DIR, "reports"), { recursive: true });
  const file = path.join(EVAL_DIR, "reports", `${stamp}-${playbook.id}-v${playbook.version}.md`);
  fs.writeFileSync(file, report);
  console.log(report);
  console.error(`\nReport written to ${path.relative(process.cwd(), file)}`);
}

function renderReport(playbookId: string, version: number, model: string, results: CaseResult[]): string {
  const allChecks = results.flatMap((r) => [r.resolution, ...r.checks]);
  const passed = allChecks.filter((c) => c.passed).length;
  const total = results.reduce((acc, r) => addUsage(acc, r.usage), emptyUsage());
  const lines = [
    `# Eval — ${playbookId} v${version}`,
    "",
    `- Model: ${model}`,
    `- Score: **${passed}/${allChecks.length}** checks passed`,
    `- Estimated cost: $${total.costUsd.toFixed(2)} (${total.webSearches} web searches) · $${(total.costUsd / Math.max(results.length, 1)).toFixed(2)} per entity`,
    "",
    "| Entity | Resolution | Checks | Cost | Time | Errors |",
    "|---|---|---|---|---|---|",
    ...results.map(
      (r) =>
        `| ${r.query} | ${r.resolution.passed ? "✓" : "✗"} | ${r.checks.filter((c) => c.passed).length}/${r.checks.length} | $${r.usage.costUsd.toFixed(2)} | ${(r.durationMs / 1000).toFixed(0)}s | ${r.failures.length} |`,
    ),
    "",
    "## Details",
    "",
  ];
  for (const r of results) {
    lines.push(`### ${r.query}`, "", `- ${r.resolution.passed ? "✓" : "✗"} Resolution: ${r.resolution.detail}`);
    for (const c of r.checks) lines.push(`- ${c.passed ? "✓" : "✗"} ${c.description} — ${c.detail}`);
    for (const f of r.failures) lines.push(`- ⚠️ ${f}`);
    lines.push("");
  }
  return lines.join("\n");
}

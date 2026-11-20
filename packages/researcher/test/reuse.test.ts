import assert from "node:assert/strict";
import { test } from "node:test";
import { entities, openDb, sectionRuns, uuidv7 } from "@kwazat/db";
import { findReusableNotes } from "../src/pipeline.ts";
import { loadPlaybook, extractionHash, researchHash, sectionHash, type ResearchSection } from "../src/playbook.ts";
import { resolveConfig } from "../src/claude.ts";

const config = resolveConfig();
const playbook = loadPlaybook("band");
const section = playbook.sections.find((s): s is ResearchSection => s.id === "legal_proceedings" && s.method === "research")!;
const edited = (patch: Partial<ResearchSection>) => ({ ...playbook, sections: playbook.sections.map((s) => (s === section ? { ...section, ...patch } : s)) });
const get = (pb: typeof playbook) => pb.sections.find((s) => s.id === section.id)!;

test("changing the extraction schema changes the section hash but not the research hash", () => {
  const changed = edited({ item_schema: { ...section.item_schema, extra: true } });
  assert.notEqual(sectionHash(changed, get(changed), config, null), sectionHash(playbook, section, config, null));
  assert.notEqual(extractionHash(get(changed), config), extractionHash(section, config));
  assert.equal(researchHash(changed, get(changed), config, null), researchHash(playbook, section, config, null));
});

test("changing the instructions, the style or the sources changes the research hash", () => {
  const base = researchHash(playbook, section, config, null);
  const instr = edited({ instructions: section.instructions + " More." });
  assert.notEqual(researchHash(instr, get(instr), config, null), base);
  assert.notEqual(researchHash({ ...playbook, style: playbook.style + " More." }, section, config, null), base);
  assert.notEqual(researchHash(playbook, section, { ...config, researchModel: "other-model" }, null), base);
});

test("notes of an earlier run are reused only when the research hash matches and they are fresh", async () => {
  const db = await openDb({ dataDir: "memory://" });
  try {
    const id = uuidv7();
    await db.insert(entities).values({ id, type: "band", label: "B" });
    const day = 86_400_000;
    const finished = new Date("2026-11-10T00:00:00Z");
    const run = { entityId: id, playbookId: "band", playbookVersion: 1, sectionId: section.id, sectionHash: "old", model: "m", status: "succeeded" as const };
    await db.insert(sectionRuns).values([
      { ...run, researchHash: "A", researchNotes: "older notes", retrievedUrls: ["https://a"], startedAt: new Date(finished.getTime() - 2 * day), finishedAt: new Date(finished.getTime() - 2 * day) },
      { ...run, researchHash: "A", researchNotes: "latest notes", retrievedUrls: ["https://b"], startedAt: finished, finishedAt: finished },
      { ...run, researchHash: "B", researchNotes: "other research", retrievedUrls: [], startedAt: finished, finishedAt: finished },
      { ...run, researchHash: null, researchNotes: "before hashes existed", retrievedUrls: [], startedAt: finished, finishedAt: finished },
    ]);
    const now = new Date(finished.getTime() + day);
    assert.deepEqual(await findReusableNotes(db, id, section, "A", now), { notes: "latest notes", retrievedUrls: ["https://b"] });
    assert.equal(await findReusableNotes(db, id, section, "C", now), null, "no run with this research hash");
    const later = new Date(finished.getTime() + (section.ttl_days + 1) * day);
    assert.equal(await findReusableNotes(db, id, section, "A", later), null, "too old: the facts may have changed");
  } finally {
    await db.close();
  }
});

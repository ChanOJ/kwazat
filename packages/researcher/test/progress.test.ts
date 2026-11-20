import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateSeconds, medianSeconds, progressPercent, runningShare, type SectionProgress } from "../src/progress.ts";

const s = (state: SectionProgress["state"], elapsedS?: number, estimateS = 100): SectionProgress => ({ estimateS, state, elapsedS });

test("nothing started is 0 %, and a running job never reaches 100 %", () => {
  assert.equal(progressPercent([s("pending"), s("pending")]), 0);
  assert.equal(progressPercent([]), 0);
  assert.equal(progressPercent([s("done"), s("done", undefined)]), 99);
  assert.equal(progressPercent([s("done", 100), s("running", 10_000)]), 98);
});

test("a running section advances with time, and slows down past its estimate", () => {
  assert.equal(progressPercent([s("running", 0), s("pending")]), 0);
  assert.equal(progressPercent([s("running", 50), s("pending")]), 25);
  assert.equal(progressPercent([s("running", 500), s("pending")]), 48);
});

test("finished sections count in full", () => {
  assert.equal(progressPercent([s("done"), s("pending"), s("pending"), s("pending")]), 25);
});

test("the estimate is calibrated on sections finished in the same job", () => {
  // The first section took twice its estimate: the rest is expected to be twice as slow.
  assert.equal(progressPercent([s("done", 200), s("running", 100), s("pending")]), 50);
  // Calibration is bounded, so one outlier cannot freeze or jump the bar.
  assert.equal(progressPercent([s("done", 1), s("pending"), s("pending")]), 33);
});

test("a section's estimate grows with its tool budget", () => {
  assert.ok(estimateSeconds({ max_searches: 8, max_fetches: 6 }) > estimateSeconds({ max_searches: 6, max_fetches: 4 }));
});

test("median and running share", () => {
  assert.equal(medianSeconds([]), null);
  assert.equal(medianSeconds([300, 10, 100]), 100);
  assert.equal(medianSeconds([10, 20]), 15);
  assert.equal(runningShare(0, 100), 0);
  assert.equal(runningShare(40, 100), 0.4);
  assert.ok(runningShare(200, 100) > runningShare(100, 100), "keeps moving past the estimate");
  assert.ok(runningShare(10_000, 100) < 0.98, "but never completes by itself");
});

test("researchProgress uses the history of the playbook, and ignores runs orphaned by a stopped server", async () => {
  const { entities, sectionRuns, openDb, uuidv7 } = await import("@kwazat/db");
  const { researchProgress } = await import("../src/worker.ts");
  const db = await openDb({ dataDir: "memory://" });
  try {
    const id = uuidv7();
    const other = uuidv7();
    await db.insert(entities).values([
      { id, type: "band", label: "Test band" },
      { id: other, type: "band", label: "Earlier band" },
    ]);
    const at = (hms: string) => new Date(`2026-11-20T${hms}Z`);
    const run = { playbookId: "band", playbookVersion: 1, model: "m", sectionHash: "old-version" };
    await db.insert(sectionRuns).values([
      // History: "a" took 60 s and 100 s on another entity and version (median 80 s); "b" never ran.
      { ...run, entityId: other, sectionId: "a", status: "succeeded", startedAt: at("08:00:00"), finishedAt: at("08:01:00") },
      { ...run, entityId: other, sectionId: "a", status: "succeeded", startedAt: at("09:00:00"), finishedAt: at("09:01:40") },
      // This job: an orphan of a stopped server, then the run that replaced it, finished.
      { ...run, entityId: id, sectionId: "a", startedAt: at("10:00:00") },
      { ...run, entityId: id, sectionId: "a", status: "succeeded", startedAt: at("10:00:30"), finishedAt: at("10:01:50"), isCurrent: true },
    ]);
    const sections = ["a", "b"].map((s) => ({ id: s, max_searches: 5, max_fetches: 3 })); // b: 230 s from the budget
    const p = await researchProgress(db, id, "band", sections, at("10:00:00"), at("10:02:00"));
    assert.equal(p.done, 1, "a counts as done despite its orphan");
    // a: estimated 80 s, took 80 s (speed 1); b: 230 s, not started: 80 / 310.
    assert.deepEqual(p, { percent: 25, done: 1, total: 2 });
    // The history alone (no run in this job) gives 0 %.
    assert.equal((await researchProgress(db, other, "band", sections, at("23:00:00"))).percent, 0);
  } finally {
    await db.close();
  }
});

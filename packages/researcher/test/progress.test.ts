import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateSeconds, progressPercent, type SectionProgress } from "../src/progress.ts";

const s = (state: SectionProgress["state"], elapsedS?: number, estimateS = 100): SectionProgress => ({ estimateS, state, elapsedS });

test("nothing started is 0 %, and a running job never reaches 100 %", () => {
  assert.equal(progressPercent([s("pending"), s("pending")]), 0);
  assert.equal(progressPercent([]), 0);
  assert.equal(progressPercent([s("done"), s("done", undefined)]), 99);
  assert.equal(progressPercent([s("done", 100), s("running", 10_000)]), 97);
});

test("a running section advances with time, up to 95 % of its estimate", () => {
  assert.equal(progressPercent([s("running", 0), s("pending")]), 0);
  assert.equal(progressPercent([s("running", 50), s("pending")]), 25);
  assert.equal(progressPercent([s("running", 500), s("pending")]), 47);
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

test("researchProgress reads the job's section runs", async () => {
  const { entities, sectionRuns, openDb, uuidv7 } = await import("@kwazat/db");
  const { researchProgress } = await import("../src/worker.ts");
  const db = await openDb({ dataDir: "memory://" });
  try {
    const id = uuidv7();
    await db.insert(entities).values({ id, type: "band", label: "Test band" });
    const since = new Date("2026-11-20T10:00:00Z");
    const run = { entityId: id, playbookId: "band", playbookVersion: 1, model: "m" };
    await db.insert(sectionRuns).values([
      { ...run, sectionId: "a", sectionHash: "h", status: "succeeded", startedAt: new Date("2026-11-20T10:00:00Z"), finishedAt: new Date("2026-11-20T10:01:00Z"), isCurrent: true },
      { ...run, sectionId: "b", sectionHash: "h", startedAt: new Date("2026-11-20T10:01:00Z") },
    ]);
    const sections = ["a", "b", "c"].map((id) => ({ id, max_searches: 5, max_fetches: 3 })); // estimate 84 s each
    const p = await researchProgress(db, id, sections, since, new Date("2026-11-20T10:01:42Z"));
    // a took 60 s (speed 60/84), b has run 42 s of an expected 60 s, c is pending.
    assert.deepEqual(p, { percent: 56, done: 1, total: 3 });
    assert.deepEqual(await researchProgress(db, id, sections, new Date("2026-11-21T00:00:00Z")), { percent: 33, done: 1, total: 3 }, "a is current, so counted as done");
  } finally {
    await db.close();
  }
});

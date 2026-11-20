/**
 * Research on demand: the web app queues a job when someone opens a subject Kwazat does not know
 * yet, and a worker runs it (identity from Wikidata first, then every research section).
 * Uses the Postgres job queue of packages/db, so the worker can run in the web server process
 * (local development, PGlite) or as its own process (Serverless Job, later).
 */
import { randomUUID } from "node:crypto";
import { and, claim, complete, desc, enqueue, eq, fail, inArray, jobs, requeueStale, sectionRuns, type Db, type Job } from "@kwazat/db";
import { resolveConfig, type RunConfig } from "./claude.ts";
import { estimateSeconds, medianSeconds, progressEstimate, type SectionProgress } from "./progress.ts";
import { loadPlaybook, type ResearchSection } from "./playbook.ts";
import { runSection, upsertEntity } from "./pipeline.ts";
import { loadRegistry } from "./sources.ts";

export const RESEARCH_JOB = "research";
/** How many earlier runs of a section the progress estimate looks at. */
const HISTORY_RUNS = 10;

export type ResearchPayload = { type: "person" | "band"; wikidataId: string };

export const researchJobKey = (p: ResearchPayload) => `${RESEARCH_JOB}:${p.type}:${p.wikidataId}`;

/** The queued or running research job of a subject, if any. */
export async function pendingResearch(db: Db, p: ResearchPayload): Promise<Job | undefined> {
  const [job] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.dedupeKey, researchJobKey(p)), inArray(jobs.status, ["queued", "running"])));
  return job;
}

/** Latest research job of a subject, whatever its status. */
export async function latestResearch(db: Db, p: ResearchPayload): Promise<Job | undefined> {
  const rows = await db.select().from(jobs).where(eq(jobs.dedupeKey, researchJobKey(p)));
  return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
}

/** Why research cannot run here, or null when the keys it needs are set. */
export function missingResearchKeys(config: RunConfig = resolveConfig()): string | null {
  const missing = [];
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) missing.push("ANTHROPIC_API_KEY");
  if (config.searchProvider.startsWith("brave") && !process.env.BRAVE_SEARCH_API_KEY) missing.push("BRAVE_SEARCH_API_KEY");
  return missing.length ? `Missing ${missing.join(" and ")}: start the app with \`pnpm app\` (keys from Proton Pass)` : null;
}

export async function runResearchJob(db: Db, payload: ResearchPayload, log: (line: string) => void = () => {}) {
  if (payload.type !== "person" && payload.type !== "band") throw new Error(`Unsupported type ${payload.type}`);
  // Identity first: free (Wikidata), and it lets the sheet page show who this is right away.
  const entity = await upsertEntity(db, payload.wikidataId, payload.type);
  log(`research ${entity.label} (${payload.wikidataId})`);
  const config = resolveConfig();
  const missing = missingResearchKeys(config);
  if (missing) throw new Error(missing);
  const playbook = loadPlaybook(payload.type);
  const registry = loadRegistry();
  const sections = playbook.sections.filter((s): s is ResearchSection => s.method === "research");
  const outcomes: Record<string, string> = {};
  for (const section of sections) {
    const outcome = await runSection(db, entity, playbook, section, config, registry);
    outcomes[section.id] = outcome.status;
    log(`  ${section.id}: ${outcome.status}${outcome.status === "failed" ? ` (${outcome.error})` : ""}`);
  }
  return { entityId: entity.id, sections: outcomes };
}

/**
 * Queues research of a subject (once: a pending job is reused). One attempt only, since each
 * run is paid; a failed research is started again by hand.
 */
export async function queueResearch(db: Db, p: ResearchPayload) {
  return enqueue(db, { kind: RESEARCH_JOB, dedupeKey: researchJobKey(p), payload: p, maxAttempts: 1 });
}

/**
 * Progress (percent and sections done) of a research job, from the section runs it started.
 * Sections already up to date before the job count as done at once.
 */
export async function researchProgress(
  db: Db,
  entityId: string,
  playbookId: string,
  sections: { id: string; max_searches: number; max_fetches: number }[],
  since: Date,
  now = new Date(),
): Promise<{ percent: number; remainingS: number; done: number; total: number }> {
  const runs = await db.select().from(sectionRuns).where(eq(sectionRuns.entityId, entityId));
  // Durations of earlier successful runs of the same playbook's sections, any entity and version.
  const history = await db
    .select({ sectionId: sectionRuns.sectionId, startedAt: sectionRuns.startedAt, finishedAt: sectionRuns.finishedAt })
    .from(sectionRuns)
    .where(and(eq(sectionRuns.playbookId, playbookId), eq(sectionRuns.status, "succeeded"), eq(sectionRuns.notesReused, false)))
    .orderBy(desc(sectionRuns.startedAt))
    .limit(200);
  const parts: SectionProgress[] = sections.map((s) => {
    const past = history
      .filter((r) => r.sectionId === s.id && r.finishedAt && r.startedAt < since)
      .slice(0, HISTORY_RUNS)
      .map((r) => (r.finishedAt!.getTime() - r.startedAt.getTime()) / 1000);
    const estimateS = medianSeconds(past) ?? estimateSeconds(s);
    // Only the latest run of the section in this job counts: an older one left "running" by a
    // stopped server must not hide the run that replaced it.
    const latest = runs
      .filter((r) => r.sectionId === s.id && r.startedAt >= since)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
    if (latest && !latest.finishedAt) return { estimateS, state: "running", elapsedS: (now.getTime() - latest.startedAt.getTime()) / 1000 };
    if (latest?.finishedAt) return { estimateS, state: "done", elapsedS: (latest.finishedAt.getTime() - latest.startedAt.getTime()) / 1000 };
    // No run in this job: done only if a current result already exists (skipped as up to date).
    return { estimateS, state: runs.some((r) => r.sectionId === s.id && r.isCurrent) ? "done" : "pending" };
  });
  return { ...progressEstimate(parts), done: parts.filter((p) => p.state === "done").length, total: parts.length };
}

/** Section runs in progress for an entity (for the waiting page). */
export async function runningSections(db: Db, entityId: string): Promise<string[]> {
  const rows = await db
    .select({ sectionId: sectionRuns.sectionId })
    .from(sectionRuns)
    .where(and(eq(sectionRuns.entityId, entityId), eq(sectionRuns.status, "running")));
  return rows.map((r) => r.sectionId);
}

/**
 * Polls the queue and runs research jobs one at a time until stopped. Jobs left running by a
 * stopped worker are put back in the queue at start.
 */
export function startResearchWorker(db: Db, opts: { pollMs?: number; log?: (line: string) => void } = {}): () => void {
  const workerId = `worker-${randomUUID()}`;
  const log = opts.log ?? ((line) => console.log(`[worker] ${line}`));
  let stopped = false;
  void (async () => {
    await requeueStale(db, 0);
    while (!stopped) {
      try {
        const job = await claim(db, workerId, [RESEARCH_JOB]);
        if (!job) {
          await new Promise((r) => setTimeout(r, opts.pollMs ?? 2000));
          continue;
        }
        try {
          await complete(db, job.id, await runResearchJob(db, job.payload as ResearchPayload, log));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log(`job ${job.id} failed: ${message}`);
          await fail(db, job.id, message);
        }
      } catch (error) {
        log(`queue error: ${error instanceof Error ? error.message : String(error)}`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  })();
  return () => {
    stopped = true;
  };
}

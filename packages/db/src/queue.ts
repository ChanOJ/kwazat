/**
 * Minimal job queue on Postgres (no extra service): enqueue with deduplication, claim with
 * FOR UPDATE SKIP LOCKED so several workers never take the same job, retries with backoff,
 * and recovery of jobs left "running" by a crashed worker.
 */
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { uuidv7 } from "./ids.ts";
import { jobs } from "./schema.ts";

type AnyDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;
export type Job = typeof jobs.$inferSelect;

/** Rows returned by db.execute(), whichever driver (PGlite returns { rows }, postgres-js an array). */
function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: T[] }).rows ?? [])) as T[];
}

const toJob = (r: Record<string, unknown>): Job => ({
  id: r.id as string,
  kind: r.kind as string,
  dedupeKey: r.dedupe_key as string,
  payload: r.payload as Record<string, unknown>,
  status: r.status as Job["status"],
  attempts: r.attempts as number,
  maxAttempts: r.max_attempts as number,
  runAfter: new Date(r.run_after as string),
  lockedAt: r.locked_at ? new Date(r.locked_at as string) : null,
  lockedBy: (r.locked_by as string) ?? null,
  lastError: (r.last_error as string) ?? null,
  result: (r.result as Record<string, unknown>) ?? null,
  createdAt: new Date(r.created_at as string),
  finishedAt: r.finished_at ? new Date(r.finished_at as string) : null,
});

/**
 * Queues a job unless one with the same dedupe key is already queued or running.
 * Returns the pending job either way, and whether it was created by this call.
 */
export async function enqueue(
  db: AnyDb,
  job: { kind: string; dedupeKey: string; payload?: Record<string, unknown>; maxAttempts?: number; runAfter?: Date },
): Promise<{ job: Job; created: boolean }> {
  const inserted = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      insert into jobs (id, kind, dedupe_key, payload, max_attempts, run_after)
      values (${uuidv7()}, ${job.kind}, ${job.dedupeKey}, ${JSON.stringify(job.payload ?? {})}::jsonb,
              ${job.maxAttempts ?? 3}, ${(job.runAfter ?? new Date()).toISOString()}::timestamptz)
      on conflict (dedupe_key) where status in ('queued', 'running') do nothing
      returning *`),
  );
  if (inserted[0]) return { job: toJob(inserted[0]), created: true };
  const existing = rowsOf<Record<string, unknown>>(
    await db.execute(
      sql`select * from jobs where dedupe_key = ${job.dedupeKey} and status in ('queued', 'running') limit 1`,
    ),
  );
  if (!existing[0]) throw new Error(`Job ${job.dedupeKey} neither inserted nor pending`);
  return { job: toJob(existing[0]), created: false };
}

/** Takes the oldest runnable job of the given kinds, or null when there is none. */
export async function claim(db: AnyDb, workerId: string, kinds: string[]): Promise<Job | null> {
  const kindList = sql.join(kinds.map((k) => sql`${k}`), sql`, `);
  const rows = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      update jobs set status = 'running', locked_at = now(), locked_by = ${workerId}, attempts = attempts + 1
      where id = (
        select id from jobs
        where status = 'queued' and run_after <= now() and kind in (${kindList})
        order by run_after, created_at
        for update skip locked
        limit 1
      )
      returning *`),
  );
  return rows[0] ? toJob(rows[0]) : null;
}

export async function complete(db: AnyDb, jobId: string, result: Record<string, unknown> = {}) {
  await db.execute(sql`
    update jobs set status = 'succeeded', result = ${JSON.stringify(result)}::jsonb, finished_at = now(),
      locked_at = null, locked_by = null
    where id = ${jobId}`);
}

/** Retries with exponential backoff (30 s, 2 min, 8 min...) until max_attempts, then fails. */
export async function fail(db: AnyDb, jobId: string, error: string) {
  await db.execute(sql`
    update jobs set
      status = case when attempts < max_attempts then 'queued'::job_status else 'failed'::job_status end,
      run_after = now() + (interval '30 seconds' * power(4, greatest(attempts - 1, 0))),
      finished_at = case when attempts < max_attempts then null else now() end,
      last_error = ${error.slice(0, 2000)}, locked_at = null, locked_by = null
    where id = ${jobId}`);
}

/** Puts back jobs whose worker stopped without finishing (crash, redeploy). */
export async function requeueStale(db: AnyDb, olderThanSeconds = 900): Promise<number> {
  const rows = rowsOf(
    await db.execute(sql`
      update jobs set status = 'queued', locked_at = null, locked_by = null
      where status = 'running' and locked_at < now() - make_interval(secs => ${olderThanSeconds})
      returning id`),
  );
  return rows.length;
}

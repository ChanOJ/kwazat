/**
 * Database tests, run twice: on embedded PGlite (development) and through the Postgres wire
 * protocol with the postgres-js driver (production code path), using pglite-socket so that no
 * Postgres server needs installing.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { claim, complete, enqueue, fail, normalizeName, openDb, requeueStale, sql, uuidv7, type Db } from "../src/index.ts";

test("uuidv7 has version 7, the RFC variant, and sorts by time", () => {
  const a = uuidv7(1_700_000_000_000);
  const b = uuidv7(1_700_000_000_001);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(a < b);
});

test("normalizeName strips accents, case and punctuation", () => {
  assert.equal(normalizeName("  Jérôme   CAHUZAC "), "jerome cahuzac");
  assert.equal(normalizeName("Jean-Marie Le Pen"), "jean marie le pen");
  assert.equal(normalizeName("L'Oréal"), "l oreal");
});

type Backend = { name: string; open: () => Promise<{ db: Db; stop: () => Promise<void> }> };

const backends: Backend[] = [
  {
    name: "PGlite",
    open: async () => {
      const db = await openDb({ dataDir: "memory://" });
      return { db, stop: () => db.close() };
    },
  },
  {
    name: "Postgres protocol (postgres-js)",
    open: async () => {
      const pglite = await PGlite.create({ extensions: { pg_trgm } });
      const server = new PGLiteSocketServer({ db: pglite, port: 0, host: "127.0.0.1" });
      await server.start();
      const address = server.getServerConn();
      const db = await openDb({ url: `postgres://postgres:postgres@${address}/postgres?sslmode=disable` });
      return {
        db,
        stop: async () => {
          await db.close();
          await server.stop();
          await pglite.close();
        },
      };
    },
  },
];

for (const backend of backends) {
  describe(`queue on ${backend.name}`, () => {
    let db: Db;
    let stop: () => Promise<void>;
    before(async () => ({ db, stop } = await backend.open()));
    after(() => stop());

    test("enqueue deduplicates pending jobs", async () => {
      const first = await enqueue(db, { kind: "research", dedupeKey: "e1:convictions", payload: { a: 1 } });
      const second = await enqueue(db, { kind: "research", dedupeKey: "e1:convictions", payload: { a: 2 } });
      assert.equal(first.created, true);
      assert.equal(second.created, false);
      assert.equal(second.job.id, first.job.id);
      assert.deepEqual(second.job.payload, { a: 1 });
    });

    test("claim takes jobs in order, once, and only of the requested kinds", async () => {
      await enqueue(db, { kind: "other", dedupeKey: "o1" });
      await enqueue(db, { kind: "research", dedupeKey: "e2:controversies" });
      const a = await claim(db, "worker-a", ["research"]);
      const b = await claim(db, "worker-b", ["research"]);
      const c = await claim(db, "worker-c", ["research"]);
      assert.equal(a?.dedupeKey, "e1:convictions");
      assert.equal(a?.status, "running");
      assert.equal(a?.attempts, 1);
      assert.equal(b?.dedupeKey, "e2:controversies");
      assert.equal(c, null);
      await complete(db, a!.id, { facts: 3 });
      // Once finished, the same work can be queued again.
      assert.equal((await enqueue(db, { kind: "research", dedupeKey: "e1:convictions" })).created, true);
    });

    test("fail retries later with backoff, then gives up", async () => {
      const { job } = await enqueue(db, { kind: "flaky", dedupeKey: "f1", maxAttempts: 2 });
      const first = await claim(db, "w", ["flaky"]);
      await fail(db, first!.id, "boom");
      assert.equal(await claim(db, "w", ["flaky"]), null, "not runnable before its backoff");
      await db.execute(sql`update jobs set run_after = now() where id = ${job.id}`);
      const second = await claim(db, "w", ["flaky"]);
      assert.equal(second?.attempts, 2);
      await fail(db, second!.id, "boom again");
      const rows = await db.execute(sql`select status, last_error from jobs where id = ${job.id}`);
      const row = (Array.isArray(rows) ? rows[0] : (rows as { rows: unknown[] }).rows[0]) as Record<string, string>;
      assert.equal(row.status, "failed");
      assert.equal(row.last_error, "boom again");
    });

    test("requeueStale puts back jobs abandoned by a worker", async () => {
      await enqueue(db, { kind: "stale", dedupeKey: "s1" });
      const job = await claim(db, "w", ["stale"]);
      await db.execute(sql`update jobs set locked_at = now() - interval '1 hour' where id = ${job!.id}`);
      assert.equal(await requeueStale(db, 900), 1);
      assert.equal((await claim(db, "w2", ["stale"]))?.id, job!.id);
    });
  });
}

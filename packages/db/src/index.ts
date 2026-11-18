import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "./schema.ts";

export * from "./schema.ts";
export * from "./ids.ts";
export * from "./queue.ts";
export { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
export { schema };

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const migrationsFolder = path.resolve(here, "../migrations");

/** Same API whatever the driver: embedded PGlite in development, Postgres in production. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema> & { close: () => Promise<void> };

export type OpenDbOptions = {
  /** Postgres connection string; defaults to DATABASE_URL. When absent, PGlite is used. */
  url?: string;
  /** PGlite data directory; defaults to KWAZAT_DB_DIR or .data/pglite. */
  dataDir?: string;
};

/**
 * Opens the database and applies migrations.
 * - DATABASE_URL set (production, CI, or a local server): regular Postgres driver.
 * - Otherwise: embedded Postgres (PGlite) in a local directory, no server to install.
 */
export async function openDb(opts: OpenDbOptions | string = {}): Promise<Db> {
  const options = typeof opts === "string" ? { dataDir: opts } : opts;
  const url = options.url ?? process.env.DATABASE_URL;
  if (url) {
    const client = postgres(url, { max: 10, onnotice: () => {} });
    const db = drizzlePostgres({ client, schema });
    await migratePostgres(db, { migrationsFolder });
    return Object.assign(db, { close: () => client.end() }) as unknown as Db;
  }
  const dataDir = options.dataDir ?? (process.env.KWAZAT_DB_DIR || path.join(repoRoot, ".data/pglite"));
  if (!dataDir.startsWith("memory://")) fs.mkdirSync(dataDir, { recursive: true });
  const client = new PGlite(dataDir, { extensions: { pg_trgm } });
  const db = drizzlePglite({ client, schema });
  await migratePglite(db, { migrationsFolder });
  return Object.assign(db, { close: () => client.close() }) as unknown as Db;
}

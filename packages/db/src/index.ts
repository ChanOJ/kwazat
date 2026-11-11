import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "./schema.ts";

export * from "./schema.ts";
export { and, eq, sql } from "drizzle-orm";
export { schema };

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const migrationsFolder = path.resolve(here, "../migrations");

export type Db = Awaited<ReturnType<typeof openDb>>;

/**
 * Opens the local development database (embedded Postgres via PGlite) and applies migrations.
 * In production this will be swapped for a regular Postgres driver with the same schema.
 */
export async function openDb(dataDir = process.env.WAZA_DB_DIR || path.join(repoRoot, ".data/pglite")) {
  fs.mkdirSync(dataDir, { recursive: true });
  const client = new PGlite(dataDir);
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder });
  return Object.assign(db, { close: () => client.close() });
}

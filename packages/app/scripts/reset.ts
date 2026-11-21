/**
 * `pnpm app:reset`: deletes this worktree's PGlite database and recreates it (migrations, then
 * the seeded accounts). The local mailbox is emptied too. Refuses while this worktree's dev
 * server runs.
 */
import fs from "node:fs";
import path from "node:path";
import { dataDir, devServerRunning, repoRoot } from "./dev-lib.ts";
import { prepareDatabase } from "./seed.ts";

if (devServerRunning()) {
  console.error("Stop `pnpm app` first: the database cannot be recreated while the server holds it.");
  process.exit(1);
}
fs.rmSync(process.env.KWAZAT_DB_DIR || path.join(dataDir, "pglite"), { recursive: true, force: true });
fs.rmSync(path.join(repoRoot, "packages/app/.data/mail"), { recursive: true, force: true });
await prepareDatabase();
console.log("Database recreated.");

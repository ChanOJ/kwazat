import { openDb, type Db } from "@kwazat/db";

/**
 * One database handle per server process. Kept on globalThis so that hot reloads in
 * development reuse it: embedded PGlite must not be opened twice on the same directory.
 */
const holder = globalThis as unknown as { kwazatDb?: Promise<Db> };

export function getDb(): Promise<Db> {
  holder.kwazatDb ??= openDb();
  return holder.kwazatDb;
}

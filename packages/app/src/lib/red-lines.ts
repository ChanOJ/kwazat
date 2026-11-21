import { eq, schema } from "@kwazat/db";
import { getDb } from "./db.ts";

/**
 * The stored (encrypted) red lines of a user. Not a server action: callers pass the id of the
 * logged-in viewer, never one that came from the browser.
 */
export async function storedRedLines(userId: string) {
  const db = await getDb();
  const t = schema.redLines;
  const [row] = await db
    .select({ ciphertext: t.ciphertext, iv: t.iv, keyWraps: t.keyWraps, revision: t.revision })
    .from(t)
    .where(eq(t.userId, userId));
  return row ?? null;
}

export type StoredRedLines = NonNullable<Awaited<ReturnType<typeof storedRedLines>>>;

"use server";

/**
 * Storage of the encrypted red lines. The server only sees ciphertext: rules are encrypted and
 * decrypted in the browser (docs/design/red-lines.md, section 0, Q6). Nothing here may log its
 * arguments or results.
 */
import { and, eq, inArray, schema, sql, type RedLineKeyWrap } from "@kwazat/db";
import { searchKnownEntities } from "@kwazat/researcher/names";
import { getDb } from "@/lib/db.ts";
import { storedRedLines } from "@/lib/red-lines.ts";
import { getViewer } from "@/lib/viewer.ts";

export type SaveInput = {
  ciphertext: string;
  iv: string;
  keyWraps: RedLineKeyWrap[];
  /** Revision the browser started from; null for the first save, which also records consent. */
  expectedRevision: number | null;
};

export type SaveResult = { ok: true; revision: number } | { ok: false; error: "conflict" | "invalid" | "auth" };

/** Upper bound of a vault: hundreds of rules fit well below it. */
const MAX_CIPHERTEXT = 65_536;
const MAX_WRAPS = 10;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const isBase64 = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max && BASE64.test(v);

function validWraps(wraps: unknown): wraps is RedLineKeyWrap[] {
  return (
    Array.isArray(wraps) &&
    wraps.length >= 1 &&
    wraps.length <= MAX_WRAPS &&
    wraps.every(
      (w) =>
        w &&
        typeof w === "object" &&
        typeof w.id === "string" &&
        /^[A-Za-z0-9]{8,32}$/.test(w.id) &&
        w.kind === "device" &&
        isBase64(w.wrapped, 128) &&
        isBase64(w.iv, 32) &&
        typeof w.createdAt === "string" &&
        !Number.isNaN(Date.parse(w.createdAt)),
    )
  );
}

export async function saveRedLines(input: SaveInput): Promise<SaveResult> {
  const viewer = await getViewer();
  if (!viewer) return { ok: false, error: "auth" };
  const { ciphertext, iv, keyWraps, expectedRevision } = input ?? ({} as SaveInput);
  if (!isBase64(ciphertext, MAX_CIPHERTEXT) || !isBase64(iv, 32) || !validWraps(keyWraps)) return { ok: false, error: "invalid" };
  // Only the known fields are stored.
  const wraps = keyWraps.map(({ id, kind, wrapped, iv: wrapIv, createdAt }) => ({ id, kind, wrapped, iv: wrapIv, createdAt }));
  const db = await getDb();
  const t = schema.redLines;

  if (expectedRevision === null) {
    const inserted = await db
      .insert(t)
      .values({ userId: viewer.id, ciphertext, iv, keyWraps: wraps, revision: 1, consentedAt: new Date() })
      .onConflictDoNothing()
      .returning({ revision: t.revision });
    return inserted[0] ? { ok: true, revision: inserted[0].revision } : { ok: false, error: "conflict" };
  }
  if (!Number.isInteger(expectedRevision)) return { ok: false, error: "invalid" };
  const updated = await db
    .update(t)
    .set({ ciphertext, iv, keyWraps: wraps, revision: sql`${t.revision} + 1`, updatedAt: new Date() })
    .where(and(eq(t.userId, viewer.id), eq(t.revision, expectedRevision)))
    .returning({ revision: t.revision });
  return updated[0] ? { ok: true, revision: updated[0].revision } : { ok: false, error: "conflict" };
}

/** Deletes the user's red lines and their consent record, on every device. */
export async function deleteRedLines(): Promise<{ ok: boolean }> {
  const viewer = await getViewer();
  if (!viewer) return { ok: false };
  const db = await getDb();
  await db.delete(schema.redLines).where(eq(schema.redLines.userId, viewer.id));
  return { ok: true };
}

/** The latest stored vault, to reload after another device saved. */
export async function loadRedLines() {
  const viewer = await getViewer();
  if (!viewer) return null;
  return storedRedLines(viewer.id);
}

export type EntityOption = { entityId: string; label: string; type: string; description: string | null; wikidataId: string | null };

/**
 * Known people and bands for the entity picker. Same lookup as the search box; queries are not
 * stored or logged.
 */
export async function findEntitiesForRule(query: string): Promise<EntityOption[]> {
  const viewer = await getViewer();
  if (!viewer || typeof query !== "string" || query.length > 100) return [];
  const db = await getDb();
  const found = (await searchKnownEntities(db, query, 8)).filter((m) => m.type === "person" || m.type === "band");
  if (!found.length) return [];
  const ids = await db
    .select({ entityId: schema.entityIdentifiers.entityId, value: schema.entityIdentifiers.value })
    .from(schema.entityIdentifiers)
    .where(and(eq(schema.entityIdentifiers.scheme, "wikidata"), inArray(schema.entityIdentifiers.entityId, found.map((m) => m.entityId))));
  const wd = new Map(ids.map((r) => [r.entityId, r.value]));
  return found.map((m) => ({ entityId: m.entityId, label: m.label, type: m.type, description: m.description, wikidataId: wd.get(m.entityId) ?? null }));
}

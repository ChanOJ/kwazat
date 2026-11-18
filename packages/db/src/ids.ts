import { randomBytes, randomInt } from "node:crypto";

/** Last timestamp used and the counter within it (RFC 9562, method 1: 12-bit counter in rand_a). */
let lastMs = -1;
let counter = 0;

/**
 * UUID version 7 (RFC 9562): 48-bit Unix timestamp in milliseconds, a 12-bit counter, then
 * random bits. Kwazat's public identifiers: opaque and stable, index-friendly, and in creation
 * order within a process, even for ids created in the same millisecond.
 */
export function uuidv7(now = Date.now()): string {
  if (now > lastMs) {
    lastMs = now;
    // Random start in the lower half leaves room for increments while staying unpredictable.
    counter = randomInt(0, 0x800);
  } else if (now === lastMs || now === lastMs - 1) {
    // Same millisecond (or the one just borrowed): next counter value, borrowing the following
    // millisecond when the counter is exhausted.
    now = lastMs;
    if (++counter > 0xfff) {
      now = ++lastMs;
      counter = 0;
    }
  } else {
    // An explicit timestamp in the past (backfill) or a clock jump back: no ordering promise.
    counter = randomInt(0, 0x1000);
  }
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = 0x70 | (counter >> 8); // version 7 + counter high bits
  bytes[7] = counter & 0xff;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 9562 variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Lowercase, without diacritics or punctuation, single spaces: the form used for name search. */
export function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

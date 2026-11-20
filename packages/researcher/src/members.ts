import { normalizeName } from "@kwazat/db";

/**
 * Finds which member of a band a name written by the research step refers to ("Flake Lorenz"
 * for the Wikidata label "Christian Lorenz"): same normalized name, else the only member whose
 * words contain all the words of the other name, else the only member with the same last word.
 * Ambiguity gives null rather than a guess.
 */
export function matchMember<T extends { label: string }>(name: string, members: T[]): T | null {
  const wanted = normalizeName(name);
  if (!wanted) return null;
  const exact = members.filter((m) => normalizeName(m.label) === wanted);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return null;
  const words = (s: string) => new Set(normalizeName(s).split(" ").filter(Boolean));
  const contains = (big: Set<string>, small: Set<string>) => small.size > 0 && [...small].every((w) => big.has(w));
  const w = words(name);
  const loose = members.filter((m) => {
    const l = words(m.label);
    return contains(l, w) || contains(w, l);
  });
  if (loose.length === 1) return loose[0]!;
  if (loose.length > 1) return null;
  const last = (s: string) => normalizeName(s).split(" ").filter(Boolean).at(-1);
  const sameLast = members.filter((m) => last(m.label) !== undefined && last(m.label) === last(name));
  return sameLast.length === 1 ? sameLast[0]! : null;
}

/**
 * Minimal Wikidata client: candidate search (disambiguation) and deterministic identity/relations.
 * Docs: https://www.wikidata.org/w/api.php
 */

const API = "https://www.wikidata.org/w/api.php";
// Wikimedia asks for a descriptive User-Agent with a way to contact the operator: the project URL
// (no personal contact details).
const USER_AGENT = "KwazatBot/0.1 (https://github.com/ChanOJ/kwazat)";
// English first (the product works in English everywhere), then "mul" (language-neutral labels).
const LANGS = ["en", "mul", "fr", "de", "es", "it"];

type Snak = { datavalue?: { value: unknown; type: string } };
type Claim = { mainsnak: Snak; qualifiers?: Record<string, Snak[]>; rank: string };
export type WdEntity = {
  id: string;
  labels?: Record<string, { value: string }>;
  descriptions?: Record<string, { value: string }>;
  aliases?: Record<string, { value: string }[]>;
  claims?: Record<string, Claim[]>;
  sitelinks?: Record<string, { title: string }>;
};

/**
 * Global throttle towards Wikidata: at most MAX_CONCURRENT requests in flight and MIN_INTERVAL_MS
 * between starts, per process. Wikimedia asks API clients to stay polite and serial-ish.
 */
const MAX_CONCURRENT = 1;
const MIN_INTERVAL_MS = 200;
let inFlight = 0;
let lastStart = 0;
const waiting: (() => void)[] = [];

async function acquire() {
  while (inFlight >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r));
  inFlight++;
  const wait = lastStart + MIN_INTERVAL_MS - Date.now();
  lastStart = Math.max(Date.now(), lastStart + MIN_INTERVAL_MS);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

function release() {
  inFlight--;
  waiting.shift()?.();
}

async function call(params: Record<string, string>): Promise<any> {
  await acquire();
  try {
    return await callUnthrottled(params);
  } finally {
    release();
  }
}

async function callUnthrottled(params: Record<string, string>): Promise<any> {
  const url = new URL(API);
  // maxlag: Wikidata answers "busy" instead of serving us when its replicas lag (bot etiquette).
  for (const [k, v] of Object.entries({ ...params, format: "json", maxlag: "5" })) url.searchParams.set(k, v);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    // Rate limited: wait as asked (Retry-After, in seconds) and retry a few times.
    if (res.status === 429 && attempt < 3) {
      const wait = Math.min(Number(res.headers.get("retry-after")) || 2 ** attempt, 5);
      process.stderr.write(`(Wikidata rate limit: retry in ${wait} s) `);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`Wikidata ${res.status} for ${url}`);
    const json = await res.json();
    // maxlag: the API answers with an error and Retry-After while its replicas catch up.
    if (json?.error?.code === "maxlag" && attempt < 3) {
      // Searches are interactive: wait briefly, never the full Retry-After.
      const wait = Number(res.headers.get("retry-after")) || 2;
      process.stderr.write(`(Wikidata busy: maxlag, retry in ${Math.min(wait, 5)} s) `);
      await new Promise((r) => setTimeout(r, Math.min(wait, 5) * 1000));
      continue;
    }
    if (json?.error) throw new Error(`Wikidata error ${json.error.code}: ${json.error.info}`);
    return json;
  }
}

function pick(map: Record<string, { value: string }> | undefined): string | null {
  for (const l of LANGS) if (map?.[l]) return map[l].value;
  return null;
}

async function getEntities(ids: string[], props: string): Promise<Record<string, WdEntity>> {
  const out: Record<string, WdEntity> = {};
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    if (!chunk.length) continue;
    const data = await call({ action: "wbgetentities", ids: chunk.join("|"), props, languages: LANGS.join("|") });
    Object.assign(out, data.entities);
  }
  return out;
}

const itemId = (s: Snak): string | null => {
  const v = s.datavalue?.value as { id?: string } | undefined;
  return s.datavalue?.type === "wikibase-entityid" && v?.id ? v.id : null;
};
const timeValue = (s: Snak | undefined): string | null => {
  const v = s?.datavalue?.value as { time?: string; precision?: number } | undefined;
  if (!v?.time) return null;
  // "+1955-01-28T00:00:00Z" -> trim according to precision (9 = year, 10 = month, 11 = day)
  const iso = v.time.replace(/^\+/, "").slice(0, 10);
  return v.precision === 9 ? iso.slice(0, 4) : v.precision === 10 ? iso.slice(0, 7) : iso;
};
const claimsOf = (e: WdEntity, prop: string): Claim[] =>
  (e.claims?.[prop] ?? []).filter((c) => c.rank !== "deprecated");
const itemIds = (e: WdEntity, prop: string): string[] =>
  claimsOf(e, prop)
    .map((c) => itemId(c.mainsnak))
    .filter((x): x is string => !!x);

const HUMAN = "Q5";
/**
 * Classes (P31) that make an item a music group: "musical group" and its common subclasses
 * (checked on Wikidata). Subclass chains are not followed: the list is explicit and extended on need.
 */
export const BAND_CLASSES = [
  "Q215380", // musical group
  "Q5741069", // rock band
  "Q56816954", // heavy metal band
  "Q216337", // boy band
  "Q641066", // girl group
  "Q281643", // musical trio
  "Q9212979", // musical duo
] as const;

export type EntityKind = "person" | "band";

/** Kind of subject an item is, from its P31 classes (null: neither a person nor a music group). */
export function kindOfClasses(classes: string[]): EntityKind | null {
  if (classes.includes(HUMAN)) return "person";
  if (classes.some((c) => (BAND_CLASSES as readonly string[]).includes(c))) return "band";
  return null;
}

export type Candidate = {
  wikidataId: string;
  label: string;
  description: string | null;
  birthDate: string | null;
  kind: EntityKind | null;
};

/** Wikibase full-text filter matching the items of the wanted kinds (`|` is OR). */
function statementFilter(kinds: EntityKind[]): string {
  const classes = kinds.flatMap((k) => (k === "person" ? [HUMAN] : [...BAND_CLASSES]));
  return `haswbstatement:${classes.map((c) => `P31=${c}`).join("|")}`;
}

/** Search candidates for a free-text name, keeping only items of the wanted kinds (people, bands). */
export async function searchCandidates(query: string, opts: { kinds: EntityKind[] }): Promise<Candidate[]> {
  const found = await call({
    action: "wbsearchentities",
    search: query,
    language: "en",
    uselang: "en",
    type: "item",
    limit: "10",
  });
  const toCandidates = async (ids: string[]) => {
    const entities = await getEntities(ids, "labels|descriptions|claims");
    return ids
      .map((id) => entities[id])
      .filter((e): e is WdEntity => !!e)
      .map((e) => ({
        wikidataId: e.id,
        label: pick(e.labels) ?? e.id,
        description: pick(e.descriptions),
        birthDate: timeValue(claimsOf(e, "P569")[0]?.mainsnak),
        kind: kindOfClasses(itemIds(e, "P31")),
      }));
  };
  const wanted = (c: Candidate) => !!c.kind && opts.kinds.includes(c.kind);
  const candidates = (await toCandidates(found.search.map((s: { id: string }) => s.id))).filter(wanted);
  if (candidates.length) return candidates;
  // Label search ranks places and other items first and may return no matching item at all
  // ("Cahuzac" is also a commune): fall back to a full-text search restricted to the wanted kinds.
  const matches = await call({
    action: "query",
    list: "search",
    srsearch: `${query} ${statementFilter(opts.kinds)}`,
    srnamespace: "0",
    srlimit: "10",
  });
  const ids: string[] = (matches.query?.search ?? []).map((r: { title: string }) => r.title);
  return (await toCandidates(ids)).filter(wanted);
}

export type WikidataRelation = {
  relationType: string;
  toWikidataId: string;
  toLabel: string;
  strength: number;
  from: string | null;
  to: string | null;
};

export type PersonIdentity = {
  wikidataId: string;
  label: string;
  description: string | null;
  aliases: string[];
  /** Labels and aliases with their language, for name search. */
  names: { name: string; lang: string }[];
  identity: {
    fullName: string;
    gender: string | null;
    nationalities: string[];
    /** ISO 3166-1 alpha-2 codes of the citizenships (P27 → P297), used to pick national sources. */
    countryCodes: string[];
    occupations: string[];
    birthDate: string | null;
    deathDate: string | null;
    photoUrl: string | null;
    wikipediaUrl: string | null;
    wikidataUrl: string;
  };
  relations: WikidataRelation[];
};

// Wikidata property -> our relation type and default strength (1 weak .. 5 structural).
const RELATION_PROPS: Record<string, { type: string; strength: number }> = {
  P26: { type: "spouse_of", strength: 5 },
  P22: { type: "child_of", strength: 5 },
  P25: { type: "child_of", strength: 5 },
  P40: { type: "parent_of", strength: 5 },
  P3373: { type: "sibling_of", strength: 4 },
  P451: { type: "partner_of", strength: 4 },
  P102: { type: "member_of_party", strength: 4 },
  P108: { type: "employee_of", strength: 3 },
  P1830: { type: "owner_of", strength: 5 },
};

/** ISO 3166-1 alpha-2 code of a country item (P297). Only that claim is fetched: country items are huge. */
async function isoCountryCode(countryId: string): Promise<string | null> {
  const data = await call({ action: "wbgetclaims", entity: countryId, property: "P297" });
  const claims = ((data.claims?.P297 ?? []) as Claim[]).filter((c) => c.rank !== "deprecated");
  const value = claims[0]?.mainsnak.datavalue?.value;
  return typeof value === "string" ? value : null;
}

/** Builds the deterministic identity block and family/party relations from Wikidata. */
export async function getPersonIdentity(wikidataId: string): Promise<PersonIdentity> {
  const e = (await getEntities([wikidataId], "labels|descriptions|aliases|claims|sitelinks"))[wikidataId];
  if (!e) throw new Error(`Wikidata item not found: ${wikidataId}`);

  const relationClaims = Object.entries(RELATION_PROPS).flatMap(([prop, meta]) =>
    claimsOf(e, prop).map((c) => ({ c, meta })),
  );
  const referenced = new Set<string>([
    ...itemIds(e, "P21"),
    ...itemIds(e, "P27"),
    ...itemIds(e, "P106"),
    ...relationClaims.map(({ c }) => itemId(c.mainsnak)).filter((x): x is string => !!x),
  ]);
  const labels = await getEntities([...referenced], "labels");
  const labelOf = (id: string) => pick(labels[id]?.labels) ?? id;
  const countryCodes = (await Promise.all(itemIds(e, "P27").map(isoCountryCode))).filter((c): c is string => !!c);

  const image = claimsOf(e, "P18")[0]?.mainsnak.datavalue?.value as string | undefined;
  const frwiki = e.sitelinks?.frwiki?.title;
  const enwiki = e.sitelinks?.enwiki?.title;
  const label = pick(e.labels) ?? wikidataId;

  return {
    wikidataId,
    label,
    description: pick(e.descriptions),
    aliases: LANGS.flatMap((l) => e.aliases?.[l]?.map((a) => a.value) ?? []),
    names: LANGS.flatMap((l) => [
      ...(e.labels?.[l] ? [{ name: e.labels[l].value, lang: l }] : []),
      ...(e.aliases?.[l]?.map((a) => ({ name: a.value, lang: l })) ?? []),
    ]),
    identity: {
      fullName: label,
      gender: itemIds(e, "P21").map(labelOf)[0] ?? null,
      nationalities: itemIds(e, "P27").map(labelOf),
      countryCodes: [...new Set(countryCodes)],
      occupations: itemIds(e, "P106").map(labelOf),
      birthDate: timeValue(claimsOf(e, "P569")[0]?.mainsnak),
      deathDate: timeValue(claimsOf(e, "P570")[0]?.mainsnak),
      photoUrl: image
        ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(image)}?width=400`
        : null,
      wikipediaUrl: enwiki
        ? `https://en.wikipedia.org/wiki/${encodeURIComponent(enwiki.replaceAll(" ", "_"))}`
        : frwiki
          ? `https://fr.wikipedia.org/wiki/${encodeURIComponent(frwiki.replaceAll(" ", "_"))}`
          : null,
      wikidataUrl: `https://www.wikidata.org/wiki/${wikidataId}`,
    },
    relations: relationClaims.flatMap(({ c, meta }) => {
      const id = itemId(c.mainsnak);
      if (!id) return [];
      return [
        {
          relationType: meta.type,
          toWikidataId: id,
          toLabel: labelOf(id),
          strength: meta.strength,
          from: timeValue(c.qualifiers?.P580?.[0]),
          to: timeValue(c.qualifiers?.P582?.[0]),
        },
      ];
    }),
  };
}

export type BandIdentity = {
  wikidataId: string;
  label: string;
  description: string | null;
  aliases: string[];
  names: { name: string; lang: string }[];
  identity: {
    fullName: string;
    /** Formation and dissolution dates (P571, P576). */
    birthDate: string | null;
    deathDate: string | null;
    origins: string[];
    /** ISO 3166-1 alpha-2 codes of the country of origin (P495 → P297), used to pick national sources. */
    countryCodes: string[];
    genres: string[];
    labels: string[];
    website: string | null;
    photoUrl: string | null;
    logoUrl: string | null;
    wikipediaUrl: string | null;
    wikidataUrl: string;
  };
  relations: WikidataRelation[];
};

const commonsUrl = (file: string | undefined, width: number) =>
  file ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=${width}` : null;

/** Builds the deterministic identity block and member relations of a music group from Wikidata. */
export async function getBandIdentity(wikidataId: string): Promise<BandIdentity> {
  const e = (await getEntities([wikidataId], "labels|descriptions|aliases|claims|sitelinks"))[wikidataId];
  if (!e) throw new Error(`Wikidata item not found: ${wikidataId}`);
  return bandFromEntity(e, async (id) => isoCountryCode(id));
}

/** Pure part of getBandIdentity (tested with fixtures); `labelsOf` resolves item labels. */
export async function bandFromEntity(
  e: WdEntity,
  countryCode: (countryId: string) => Promise<string | null>,
  labelsOf: (ids: string[]) => Promise<Record<string, string>> = async (ids) => {
    const labels = await getEntities(ids, "labels");
    return Object.fromEntries(ids.map((id) => [id, pick(labels[id]?.labels) ?? id]));
  },
): Promise<BandIdentity> {
  const wikidataId = e.id;
  const members = claimsOf(e, "P527").flatMap((c) => {
    const id = itemId(c.mainsnak);
    return id ? [{ c, id }] : [];
  });
  const referenced = [
    ...new Set([
      ...itemIds(e, "P495"),
      ...itemIds(e, "P740"),
      ...itemIds(e, "P136"),
      ...itemIds(e, "P264"),
      ...members.map((m) => m.id),
    ]),
  ];
  const names = await labelsOf(referenced);
  const labelOf = (id: string) => names[id] ?? id;
  const countryCodes = (await Promise.all(itemIds(e, "P495").map(countryCode))).filter((c): c is string => !!c);

  const str = (prop: string) => claimsOf(e, prop)[0]?.mainsnak.datavalue?.value as string | undefined;
  const frwiki = e.sitelinks?.frwiki?.title;
  const enwiki = e.sitelinks?.enwiki?.title;
  const label = pick(e.labels) ?? wikidataId;
  const wiki = (lang: string, title: string) => `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(" ", "_"))}`;

  return {
    wikidataId,
    label,
    description: pick(e.descriptions),
    aliases: LANGS.flatMap((l) => e.aliases?.[l]?.map((a) => a.value) ?? []),
    names: LANGS.flatMap((l) => [
      ...(e.labels?.[l] ? [{ name: e.labels[l].value, lang: l }] : []),
      ...(e.aliases?.[l]?.map((a) => ({ name: a.value, lang: l })) ?? []),
    ]),
    identity: {
      fullName: label,
      birthDate: timeValue(claimsOf(e, "P571")[0]?.mainsnak),
      deathDate: timeValue(claimsOf(e, "P576")[0]?.mainsnak),
      origins: [...new Set([...itemIds(e, "P495"), ...itemIds(e, "P740")].map(labelOf))],
      countryCodes: [...new Set(countryCodes)],
      genres: itemIds(e, "P136").map(labelOf),
      labels: itemIds(e, "P264").map(labelOf),
      website: str("P856")?.startsWith("https://") || str("P856")?.startsWith("http://") ? (str("P856") ?? null) : null,
      photoUrl: commonsUrl(str("P18"), 400),
      logoUrl: commonsUrl(str("P154"), 200),
      wikipediaUrl: enwiki ? wiki("en", enwiki) : frwiki ? wiki("fr", frwiki) : null,
      wikidataUrl: `https://www.wikidata.org/wiki/${wikidataId}`,
    },
    // Members (P527 "has part"), with their membership dates when Wikidata has them.
    relations: members.map(({ c, id }) => ({
      relationType: "has_member",
      toWikidataId: id,
      toLabel: labelOf(id),
      strength: 5,
      from: timeValue(c.qualifiers?.P580?.[0]),
      to: timeValue(c.qualifiers?.P582?.[0]),
    })),
  };
}

/**
 * Minimal Wikidata client: candidate search (disambiguation) and deterministic identity/relations.
 * Docs: https://www.wikidata.org/w/api.php
 */

const API = "https://www.wikidata.org/w/api.php";
// Wikimedia asks for a descriptive User-Agent. Kept generic on purpose (no personal contact info).
const USER_AGENT = "WazaResearcher/0.1 (development)";
// English first (the product works in English everywhere), then "mul" (language-neutral labels).
const LANGS = ["en", "mul", "fr", "de", "es", "it"];

type Snak = { datavalue?: { value: unknown; type: string } };
type Claim = { mainsnak: Snak; qualifiers?: Record<string, Snak[]>; rank: string };
type WdEntity = {
  id: string;
  labels?: Record<string, { value: string }>;
  descriptions?: Record<string, { value: string }>;
  aliases?: Record<string, { value: string }[]>;
  claims?: Record<string, Claim[]>;
  sitelinks?: Record<string, { title: string }>;
};

async function call(params: Record<string, string>): Promise<any> {
  const url = new URL(API);
  for (const [k, v] of Object.entries({ ...params, format: "json" })) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`Wikidata ${res.status} for ${url}`);
  return res.json();
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

export type Candidate = {
  wikidataId: string;
  label: string;
  description: string | null;
  birthDate: string | null;
  isHuman: boolean;
};

/** Search candidates for a free-text name. For persons, keeps only humans (P31 = Q5). */
export async function searchCandidates(query: string, opts: { humansOnly: boolean }): Promise<Candidate[]> {
  const found = await call({
    action: "wbsearchentities",
    search: query,
    language: "en",
    uselang: "en",
    type: "item",
    limit: "10",
  });
  const ids: string[] = found.search.map((s: { id: string }) => s.id);
  const entities = await getEntities(ids, "labels|descriptions|claims");
  const candidates = ids
    .map((id) => entities[id])
    .filter((e): e is WdEntity => !!e)
    .map((e) => ({
      wikidataId: e.id,
      label: pick(e.labels) ?? e.id,
      description: pick(e.descriptions),
      birthDate: timeValue(claimsOf(e, "P569")[0]?.mainsnak),
      isHuman: itemIds(e, "P31").includes(HUMAN),
    }));
  return opts.humansOnly ? candidates.filter((c) => c.isHuman) : candidates;
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
  identity: {
    fullName: string;
    gender: string | null;
    nationalities: string[];
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

  const image = claimsOf(e, "P18")[0]?.mainsnak.datavalue?.value as string | undefined;
  const frwiki = e.sitelinks?.frwiki?.title;
  const enwiki = e.sitelinks?.enwiki?.title;
  const label = pick(e.labels) ?? wikidataId;

  return {
    wikidataId,
    label,
    description: pick(e.descriptions),
    aliases: LANGS.flatMap((l) => e.aliases?.[l]?.map((a) => a.value) ?? []),
    identity: {
      fullName: label,
      gender: itemIds(e, "P21").map(labelOf)[0] ?? null,
      nationalities: itemIds(e, "P27").map(labelOf),
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

import assert from "node:assert/strict";
import { test } from "node:test";
import { loadPlaybook } from "../src/playbook.ts";
import { subjectBlock } from "../src/claude.ts";
import { BAND_CLASSES, bandFromEntity, kindOfClasses, type WdEntity } from "../src/wikidata.ts";

const item = (id: string) => ({ datavalue: { type: "wikibase-entityid", value: { id } } });
const text = (value: string) => ({ datavalue: { type: "string", value } });
const time = (iso: string, precision: number) => ({ datavalue: { type: "time", value: { time: iso, precision } } });
const claim = (mainsnak: object, qualifiers?: Record<string, object[]>, rank = "normal") => ({ mainsnak, qualifiers, rank });

// Trimmed from Wikidata Q25177 (Rammstein), with invented member dates to cover qualifiers.
const band = {
  id: "Q25177",
  labels: { en: { value: "Rammstein" } },
  descriptions: { en: { value: "German industrial metal band" } },
  aliases: { de: [{ value: "Rammstein (Band)" }] },
  sitelinks: { enwiki: { title: "Rammstein" } },
  claims: {
    P31: [claim(item("Q215380"))],
    P571: [claim(time("+1994-01-04T00:00:00Z", 11))],
    P495: [claim(item("Q183"))],
    P740: [claim(item("Q64"))],
    P136: [claim(item("Q213572"))],
    P264: [claim(item("Q707732"))],
    P856: [claim(text("https://rammstein.de"))],
    P18: [claim(text("Rammstein at Wacken.jpg"))],
    P154: [claim(text("Rammstein logo.svg"))],
    P527: [
      claim(item("Q154852")),
      claim(item("Q77040"), { P580: [time("+1994-01-01T00:00:00Z", 9)], P582: [time("+2000-01-01T00:00:00Z", 9)] }),
      claim(item("Q165644"), undefined, "deprecated"),
    ],
  },
} as unknown as WdEntity;

const labels: Record<string, string> = {
  Q183: "Germany",
  Q64: "Berlin",
  Q213572: "Neue Deutsche Härte",
  Q707732: "Universal Music",
  Q154852: "Till Lindemann",
  Q77040: "Christian Lorenz",
};

test("a music group's identity and members come from Wikidata claims", async () => {
  const b = await bandFromEntity(
    band,
    async (id) => (id === "Q183" ? "DE" : null),
    async (ids) => Object.fromEntries(ids.map((id) => [id, labels[id] ?? id])),
  );
  assert.equal(b.label, "Rammstein");
  assert.equal(b.identity.birthDate, "1994-01-04");
  assert.equal(b.identity.deathDate, null);
  assert.deepEqual(b.identity.origins, ["Germany", "Berlin"]);
  assert.deepEqual(b.identity.countryCodes, ["DE"]);
  assert.deepEqual(b.identity.genres, ["Neue Deutsche Härte"]);
  assert.deepEqual(b.identity.labels, ["Universal Music"]);
  assert.equal(b.identity.website, "https://rammstein.de");
  assert.match(b.identity.photoUrl ?? "", /Special:FilePath\/Rammstein%20at%20Wacken\.jpg/);
  assert.match(b.identity.logoUrl ?? "", /Rammstein%20logo\.svg/);
  assert.equal(b.identity.wikipediaUrl, "https://en.wikipedia.org/wiki/Rammstein");
  // Deprecated claims are ignored; member dates come from the qualifiers.
  assert.deepEqual(
    b.relations.map((r) => [r.relationType, r.toLabel, r.from, r.to]),
    [
      ["has_member", "Till Lindemann", null, null],
      ["has_member", "Christian Lorenz", "1994", "2000"],
    ],
  );
  assert.ok(b.names.some((n) => n.name === "Rammstein (Band)" && n.lang === "de"));
});

test("a website that is not an http(s) URL is dropped", async () => {
  const odd = { ...band, claims: { ...band.claims, P856: [claim(text("javascript:alert(1)"))] } } as unknown as WdEntity;
  const b = await bandFromEntity(odd, async () => null, async () => ({}));
  assert.equal(b.identity.website, null);
});

test("items are classified as person, band or neither from their classes", () => {
  assert.equal(kindOfClasses(["Q5"]), "person");
  for (const c of BAND_CLASSES) assert.equal(kindOfClasses([c]), "band", c);
  assert.equal(kindOfClasses(["Q482994"]), null, "an album is neither");
  assert.equal(kindOfClasses([]), null);
});

test("the band playbook loads, with the sections the sheet page and messages know", () => {
  const pb = loadPlaybook("band");
  assert.equal(pb.entity_type, "band");
  assert.deepEqual(
    pb.sections.map((s) => s.id),
    ["identity", "legal_proceedings", "investigative_revelations", "controversies"],
  );
});

test("the research prompt tells a band from a person", () => {
  const base = { label: "Rammstein", wikidataId: "Q25177", description: null, birthDate: "1994-01-04", occupations: [], nationalities: [] };
  const block = subjectBlock({ ...base, kind: "band", genres: ["Neue Deutsche Härte"] });
  assert.match(block, /Type: music group/);
  assert.match(block, /Formed: 1994-01-04/);
  assert.doesNotMatch(subjectBlock(base), /Formed|music group/);
});

test("band members link to known sheets, and a person's sheet links back to its bands", async () => {
  const { entities, entityIdentifiers, relations, openDb, uuidv7 } = await import("@kwazat/db");
  const { bandsOfMember, knownByWikidataIds } = await import("../src/names.ts");
  const db = await openDb({ dataDir: "memory://" });
  try {
    const [bandId, personId] = [uuidv7(), uuidv7()];
    await db.insert(entities).values([
      { id: bandId, type: "band", label: "Rammstein" },
      { id: personId, type: "person", label: "Till Lindemann" },
    ]);
    await db.insert(entityIdentifiers).values({ entityId: personId, scheme: "wikidata", value: "Q154852", source: "test" });
    await db.insert(relations).values([
      { fromEntityId: bandId, toLabel: "Till Lindemann", toWikidataId: "Q154852", relationType: "has_member", strength: 5, sources: [], origin: "wikidata", reviewStatus: "published" },
      { fromEntityId: bandId, toLabel: "Flake Lorenz", toWikidataId: "Q155687", relationType: "has_member", strength: 5, sources: [], origin: "wikidata", reviewStatus: "published" },
    ]);
    const known = await knownByWikidataIds(db, ["Q154852", "Q155687"]);
    assert.deepEqual([...known], [["Q154852", personId]]);
    assert.deepEqual(await bandsOfMember(db, "Q154852"), [{ entityId: bandId, label: "Rammstein" }]);
    assert.deepEqual(await bandsOfMember(db, "Q1"), []);
  } finally {
    await db.close();
  }
});

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { entities, entityIdentifiers, eq, openDb, uuidv7, type Db } from "@kwazat/db";
import { findEntity, findEntityByIdentifier, searchKnownEntities, setEntityNames } from "../src/names.ts";

let db: Db;
const keep = uuidv7();
const duplicate = uuidv7();

before(async () => {
  db = await openDb({ dataDir: "memory://" });
  await db.insert(entities).values([
    { id: keep, type: "person", label: "Jérôme Cahuzac", description: "French politician" },
    { id: duplicate, type: "person", label: "Jerome Cahuzac", description: "duplicate" },
  ]);
  await db.insert(entityIdentifiers).values({ entityId: duplicate, scheme: "wikidata", value: "Q57751", source: "test" });
  await setEntityNames(db, keep, [
    { name: "Jérôme Cahuzac", lang: "fr" },
    { name: "Jerome Cahuzac", lang: "en" }, // same normalized form: stored once
  ]);
  await setEntityNames(db, duplicate, [{ name: "Jerome Cahuzac", lang: "en" }]);
});
after(() => db.close());

test("known entities are found despite accents and typos", async () => {
  const [first] = await searchKnownEntities(db, "jerome cahusac");
  assert.equal(first?.label, "Jérôme Cahuzac");
  assert.equal((await searchKnownEntities(db, "ca")).length, 0, "queries under 3 characters are ignored");
});

test("merged entities redirect and disappear from search", async () => {
  await db.update(entities).set({ mergedInto: keep }).where(eq(entities.id, duplicate));
  assert.equal((await findEntity(db, duplicate))?.id, keep);
  assert.equal((await findEntityByIdentifier(db, "wikidata", "Q57751"))?.id, keep);
  const results = await searchKnownEntities(db, "jerome cahuzac");
  assert.deepEqual(results.map((r) => r.entityId), [keep]);
});

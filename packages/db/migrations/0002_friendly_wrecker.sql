-- Move existing Wikidata ids to the correspondence table before dropping the column.
INSERT INTO "entity_identifiers" ("entity_id", "scheme", "value", "source")
SELECT "id", 'wikidata', "wikidata_id", 'wikidata' FROM "entities" WHERE "wikidata_id" IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "entities" DROP COLUMN "wikidata_id";
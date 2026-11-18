-- Trigram index support for name search (available in PGlite and Scaleway managed Postgres).
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "entity_identifiers" (
	"entity_id" uuid NOT NULL,
	"scheme" text NOT NULL,
	"value" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entity_identifiers_scheme_value_pk" PRIMARY KEY("scheme","value")
);
--> statement-breakpoint
CREATE TABLE "entity_names" (
	"entity_id" uuid NOT NULL,
	"name" text NOT NULL,
	"lang" text,
	"normalized" text NOT NULL,
	CONSTRAINT "entity_names_entity_id_normalized_pk" PRIMARY KEY("entity_id","normalized")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "wikidata_search_cache" (
	"query" text NOT NULL,
	"lang" text NOT NULL,
	"humans_only" boolean NOT NULL,
	"results" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wikidata_search_cache_query_lang_humans_only_pk" PRIMARY KEY("query","lang","humans_only")
);
--> statement-breakpoint
DROP INDEX "entities_wikidata_id_idx";--> statement-breakpoint
ALTER TABLE "entities" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "merged_into" uuid;--> statement-breakpoint
ALTER TABLE "entity_identifiers" ADD CONSTRAINT "entity_identifiers_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_names" ADD CONSTRAINT "entity_names_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entity_identifiers_entity_idx" ON "entity_identifiers" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "entity_names_trgm_idx" ON "entity_names" USING gin ("normalized" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_pending_dedupe_idx" ON "jobs" USING btree ("dedupe_key") WHERE "jobs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("status","run_after");--> statement-breakpoint
CREATE INDEX "entities_merged_into_idx" ON "entities" USING btree ("merged_into");
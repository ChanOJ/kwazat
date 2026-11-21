CREATE TABLE "page_cache" (
	"url" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"title" text,
	"text" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_corpora" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"section_id" text NOT NULL,
	"corpus_hash" text NOT NULL,
	"docs" jsonb NOT NULL,
	"usage" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"query" jsonb NOT NULL,
	"results" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "research_corpora" ADD CONSTRAINT "research_corpora_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_cache_fetched_at_idx" ON "page_cache" USING btree ("fetched_at");--> statement-breakpoint
CREATE INDEX "research_corpora_entity_section_idx" ON "research_corpora" USING btree ("entity_id","section_id");--> statement-breakpoint
CREATE INDEX "search_cache_fetched_at_idx" ON "search_cache" USING btree ("fetched_at");
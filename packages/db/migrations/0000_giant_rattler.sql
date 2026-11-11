CREATE TYPE "public"."entity_type" AS ENUM('person', 'brand', 'product');--> statement-breakpoint
CREATE TYPE "public"."review_status" AS ENUM('published', 'needs_review', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "entity_type" NOT NULL,
	"wikidata_id" text,
	"label" text NOT NULL,
	"description" text,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"identity" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"section_run_id" uuid NOT NULL,
	"section_id" text NOT NULL,
	"statement" text NOT NULL,
	"fact_date" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" text NOT NULL,
	"review_status" "review_status" DEFAULT 'needs_review' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_entity_id" uuid NOT NULL,
	"to_entity_id" uuid,
	"to_label" text NOT NULL,
	"to_wikidata_id" text,
	"relation_type" text NOT NULL,
	"share_pct" numeric(6, 3),
	"strength" integer DEFAULT 3 NOT NULL,
	"description" text,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"origin" text NOT NULL,
	"section_run_id" uuid,
	"review_status" "review_status" DEFAULT 'needs_review' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "section_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"playbook_id" text NOT NULL,
	"playbook_version" integer NOT NULL,
	"section_id" text NOT NULL,
	"section_hash" text NOT NULL,
	"model" text NOT NULL,
	"status" "run_status" DEFAULT 'running' NOT NULL,
	"research_notes" text,
	"retrieved_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"usage" jsonb,
	"cost_usd" numeric(10, 4),
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"is_current" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_section_run_id_section_runs_id_fk" FOREIGN KEY ("section_run_id") REFERENCES "public"."section_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_from_entity_id_entities_id_fk" FOREIGN KEY ("from_entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_to_entity_id_entities_id_fk" FOREIGN KEY ("to_entity_id") REFERENCES "public"."entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_section_run_id_section_runs_id_fk" FOREIGN KEY ("section_run_id") REFERENCES "public"."section_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "section_runs" ADD CONSTRAINT "section_runs_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "entities_wikidata_id_idx" ON "entities" USING btree ("wikidata_id");--> statement-breakpoint
CREATE INDEX "facts_entity_section_idx" ON "facts" USING btree ("entity_id","section_id");--> statement-breakpoint
CREATE INDEX "relations_from_idx" ON "relations" USING btree ("from_entity_id");--> statement-breakpoint
CREATE INDEX "relations_to_wikidata_idx" ON "relations" USING btree ("to_wikidata_id");--> statement-breakpoint
CREATE INDEX "section_runs_entity_section_idx" ON "section_runs" USING btree ("entity_id","section_id");
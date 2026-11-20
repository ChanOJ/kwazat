ALTER TABLE "section_runs" ADD COLUMN "research_hash" text;--> statement-breakpoint
ALTER TABLE "section_runs" ADD COLUMN "notes_reused" boolean DEFAULT false NOT NULL;
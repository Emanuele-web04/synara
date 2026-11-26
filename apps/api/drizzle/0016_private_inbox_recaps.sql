CREATE TABLE "inbox_recaps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"source_host_id" uuid NOT NULL,
	"source_host_name" text NOT NULL,
	"day" text NOT NULL,
	"timezone" text NOT NULL,
	"recap" jsonb NOT NULL,
	"saved_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inbox_recaps" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_recaps_source_day_unique" ON "inbox_recaps" USING btree ("user_id","org_id","source_host_id","day","timezone");--> statement-breakpoint
CREATE INDEX "inbox_recaps_history_idx" ON "inbox_recaps" USING btree ("user_id","org_id","saved_at","id");
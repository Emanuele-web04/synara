ALTER TABLE "inbox_recaps" ALTER COLUMN "recap" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "inbox_recaps" ADD COLUMN "deleted_at" timestamp (3) with time zone;
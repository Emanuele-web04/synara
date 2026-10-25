ALTER TABLE "live_activities" ADD COLUMN "delivery_kind" text DEFAULT 'liveactivity' NOT NULL;--> statement-breakpoint
ALTER TABLE "live_activities" ADD COLUMN "notification_source" text;--> statement-breakpoint
CREATE UNIQUE INDEX "live_activities_notification_source_idx" ON "live_activities" USING btree ("device_id","notification_source");
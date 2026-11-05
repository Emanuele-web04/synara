CREATE TABLE "live_activities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"session_id" text NOT NULL,
	"device_id" uuid NOT NULL,
	"request" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended" boolean DEFAULT false NOT NULL,
	"dirty" boolean DEFAULT true NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_timestamp" bigint DEFAULT 0 NOT NULL,
	"last_payload" text
);
--> statement-breakpoint
ALTER TABLE "live_activities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "live_activity_hosts" (
	"host_id" uuid PRIMARY KEY NOT NULL,
	"key_generation" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "live_activity_hosts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "live_activities" ADD CONSTRAINT "live_activities_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_activity_hosts" ADD CONSTRAINT "live_activity_hosts_host_id_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "live_activities_delivery_idx" ON "live_activities" USING btree ("ended","next_attempt_at");
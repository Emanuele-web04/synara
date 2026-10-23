CREATE TABLE "device_account_sessions" (
	"device_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "device_account_sessions" ADD CONSTRAINT "device_account_sessions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "device_account_sessions_binding_unique" ON "device_account_sessions" USING btree ("device_id","session_id");--> statement-breakpoint
CREATE INDEX "device_account_sessions_session_idx" ON "device_account_sessions" USING btree ("user_id","session_id");
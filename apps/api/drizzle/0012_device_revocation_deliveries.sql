CREATE TABLE "device_revocation_deliveries" (
	"device_id" uuid NOT NULL,
	"host_id" uuid NOT NULL,
	"revoked_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "device_revocation_deliveries" ADD CONSTRAINT "device_revocation_deliveries_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "device_revocation_deliveries_unique" ON "device_revocation_deliveries" USING btree ("device_id","host_id");--> statement-breakpoint
CREATE INDEX "device_revocation_deliveries_host_idx" ON "device_revocation_deliveries" USING btree ("host_id");
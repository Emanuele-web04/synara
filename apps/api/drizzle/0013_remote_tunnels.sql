CREATE TABLE "remote_tunnels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"owner_org_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"key_generation" integer NOT NULL,
	"hostname" text NOT NULL,
	"tunnel_name" text NOT NULL,
	"tunnel_id" text,
	"dns_record_id" text,
	"origin_port" integer NOT NULL,
	"desired" boolean DEFAULT true NOT NULL,
	"ready" boolean DEFAULT false NOT NULL,
	"lease_id" uuid,
	"lease_until" timestamp with time zone,
	"cleaned_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "remote_tunnels_active_host_unique" ON "remote_tunnels" USING btree ("host_id") WHERE "remote_tunnels"."desired" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "remote_tunnels_hostname_unique" ON "remote_tunnels" USING btree ("hostname");--> statement-breakpoint
CREATE UNIQUE INDEX "remote_tunnels_name_unique" ON "remote_tunnels" USING btree ("tunnel_name");--> statement-breakpoint
CREATE INDEX "remote_tunnels_cleanup_idx" ON "remote_tunnels" USING btree ("desired","cleaned_at");
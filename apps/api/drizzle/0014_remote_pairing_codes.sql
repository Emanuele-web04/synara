CREATE TABLE "remote_pairing_budgets" (
	"key" text PRIMARY KEY NOT NULL,
	"attempts" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "remote_pairing_codes" (
	"invite_id" uuid PRIMARY KEY NOT NULL,
	"host_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"owner_org_id" text NOT NULL,
	"key_generation" integer NOT NULL,
	"code" text NOT NULL,
	"bundle" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_jkt" text,
	"cancelled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "remote_pairing_codes_code_unique" ON "remote_pairing_codes" USING btree ("code");--> statement-breakpoint
CREATE INDEX "remote_pairing_codes_expiry_idx" ON "remote_pairing_codes" USING btree ("expires_at");
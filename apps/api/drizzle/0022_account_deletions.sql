CREATE TABLE "account_deletions" (
	"user_id" text PRIMARY KEY NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"identity_deleted_at" timestamp with time zone,
	"lease_until" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "account_deletions" ENABLE ROW LEVEL SECURITY;
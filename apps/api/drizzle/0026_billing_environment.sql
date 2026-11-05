CREATE TABLE "billing_environment" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"environment" text NOT NULL,
	CONSTRAINT "billing_environment_singleton" CHECK ("billing_environment"."id" = 1),
	CONSTRAINT "billing_environment_mode" CHECK ("billing_environment"."environment" IN ('sandbox', 'production'))
);
--> statement-breakpoint
ALTER TABLE "billing_environment" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Earlier billing migrations only supported the sandbox. Preserve that namespace.
INSERT INTO "billing_environment" ("id", "environment")
SELECT 1, 'sandbox'
WHERE EXISTS (SELECT 1 FROM "billing_accounts")
   OR EXISTS (SELECT 1 FROM "billing_webhook_events")
ON CONFLICT ("id") DO NOTHING;

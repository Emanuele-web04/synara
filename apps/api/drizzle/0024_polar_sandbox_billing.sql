CREATE TABLE "billing_accounts" (
	"user_id" text PRIMARY KEY NOT NULL,
	"customer_id" text,
	"product_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"access_granted" boolean DEFAULT false NOT NULL,
	"subscription_status" text,
	"valid_until" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"has_subscription" boolean DEFAULT false NOT NULL,
	"checked_at" timestamp with time zone,
	"checkout_attempt_id" uuid,
	"checkout_product_id" text,
	"checkout_url" text,
	"checkout_interval" text,
	"checkout_expires_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "billing_accounts_customer_id_unique" UNIQUE("customer_id")
);
--> statement-breakpoint
ALTER TABLE "billing_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "billing_webhook_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"handled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "billing_webhook_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "billing_webhook_events_pending_idx" ON "billing_webhook_events" USING btree ("next_attempt_at") WHERE "billing_webhook_events"."handled_at" IS NULL;
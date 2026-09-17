ALTER TYPE "public"."campaign_status" ADD VALUE IF NOT EXISTS 'SCHEDULED';--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "scheduled_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaigns_scheduled_due_idx" ON "campaigns" USING btree ("status", "scheduled_at");

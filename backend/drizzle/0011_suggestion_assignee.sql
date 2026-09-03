ALTER TABLE "suggestions" ADD COLUMN "assignee_nickname" text;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_assignee_pair" CHECK (("suggestions"."assignee" IS NULL AND "suggestions"."assignee_nickname" IS NULL)
          OR ("suggestions"."assignee" IS NOT NULL AND "suggestions"."assignee_nickname" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_assignee_nickname_length" CHECK ("suggestions"."assignee_nickname" IS NULL OR length("suggestions"."assignee_nickname") BETWEEN 1 AND 64);
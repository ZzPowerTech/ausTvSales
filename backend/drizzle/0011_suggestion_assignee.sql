ALTER TABLE "suggestions" ADD COLUMN "assignee_nickname" text;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_assignee_pair" CHECK (("suggestions"."assignee" IS NULL AND "suggestions"."assignee_nickname" IS NULL)
          OR ("suggestions"."assignee" IS NOT NULL AND "suggestions"."assignee_nickname" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_assignee_nickname_valid" CHECK ("suggestions"."assignee_nickname" IS NULL
          OR (length("suggestions"."assignee_nickname") <= 64
              AND btrim("suggestions"."assignee_nickname", E'\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF') <> ''));
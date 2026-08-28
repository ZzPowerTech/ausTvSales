CREATE TABLE "tutorial_daily" (
	"day" date NOT NULL,
	"platform" text NOT NULL,
	"entered" integer NOT NULL,
	"completed" integer NOT NULL,
	CONSTRAINT "tutorial_daily_day_platform_pk" PRIMARY KEY("day","platform"),
	CONSTRAINT "tutorial_daily_entered_non_negative" CHECK ("tutorial_daily"."entered" >= 0),
	CONSTRAINT "tutorial_daily_completed_non_negative" CHECK ("tutorial_daily"."completed" >= 0)
);
--> statement-breakpoint
CREATE TABLE "tutorial_syncs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tutorial_syncs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text NOT NULL,
	"files_scanned" integer,
	"files_failed" integer,
	"quests_in_catalogue" integer,
	"final_quest_id" text,
	"detail" text,
	CONSTRAINT "tutorial_syncs_status_valid" CHECK ("tutorial_syncs"."status" IN ('ok', 'error'))
);
--> statement-breakpoint
CREATE INDEX "tutorial_daily_platform_day_idx" ON "tutorial_daily" USING btree ("platform","day");--> statement-breakpoint
CREATE INDEX "tutorial_syncs_ran_at_idx" ON "tutorial_syncs" USING btree ("ran_at" DESC NULLS LAST);
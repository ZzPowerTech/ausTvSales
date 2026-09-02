CREATE TABLE "tutorial_player_position" (
	"player_uuid" uuid PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"quests_touched" integer NOT NULL,
	"quests_completed" integer NOT NULL,
	"furthest_quest_id" text,
	"furthest_index" integer,
	"completed_tutorial" boolean NOT NULL,
	"entered_on" date,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tutorial_player_position_counts_non_negative" CHECK ("tutorial_player_position"."quests_touched" >= 0 AND "tutorial_player_position"."quests_completed" >= 0),
	CONSTRAINT "tutorial_player_position_touched_positive" CHECK ("tutorial_player_position"."quests_touched" > 0)
);
--> statement-breakpoint
ALTER TABLE "tutorial_syncs" ADD COLUMN "step_order" text;--> statement-breakpoint
ALTER TABLE "tutorial_syncs" ADD COLUMN "positions_written" integer;--> statement-breakpoint
CREATE INDEX "tutorial_player_position_index_idx" ON "tutorial_player_position" USING btree ("furthest_index","platform");
CREATE TABLE "player_dimension" (
	"uuid" uuid PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"registered_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_dimension_syncs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "player_dimension_syncs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text NOT NULL,
	"rows_read" integer,
	"rows_written" integer,
	"rows_dropped" integer,
	"duration_ms" integer,
	"detail" text,
	CONSTRAINT "player_dimension_syncs_status_valid" CHECK ("player_dimension_syncs"."status" IN ('ok', 'error'))
);
--> statement-breakpoint
CREATE INDEX "player_dimension_registered_at_idx" ON "player_dimension" USING btree ("registered_at","platform");--> statement-breakpoint
CREATE INDEX "player_dimension_syncs_ran_at_idx" ON "player_dimension_syncs" USING btree ("ran_at" DESC NULLS LAST);
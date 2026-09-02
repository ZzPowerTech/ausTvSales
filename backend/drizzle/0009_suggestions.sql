CREATE TABLE "suggestions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "suggestions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"discord_msg_id" text NOT NULL,
	"author" text NOT NULL,
	"text" text NOT NULL,
	"votes_up" integer DEFAULT 0 NOT NULL,
	"votes_down" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'enviada' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assignee" text,
	CONSTRAINT "suggestions_status_valid" CHECK ("suggestions"."status" IN ('enviada', 'aprovada', 'em_andamento', 'concluida', 'recusada')),
	CONSTRAINT "suggestions_votes_non_negative" CHECK ("suggestions"."votes_up" >= 0 AND "suggestions"."votes_down" >= 0),
	CONSTRAINT "suggestions_text_present" CHECK (length(btrim("suggestions"."text")) > 0),
	CONSTRAINT "suggestions_text_max_length" CHECK (length("suggestions"."text") <= 2000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "suggestions_discord_msg_id_unique" ON "suggestions" USING btree ("discord_msg_id");--> statement-breakpoint
CREATE INDEX "suggestions_status_created_at_idx" ON "suggestions" USING btree ("status","created_at");
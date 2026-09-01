CREATE TABLE "account_creations_daily" (
	"day" date PRIMARY KEY NOT NULL,
	"created" integer NOT NULL,
	CONSTRAINT "account_creations_daily_created_non_negative" CHECK ("account_creations_daily"."created" >= 0)
);
--> statement-breakpoint
CREATE TABLE "player_payment_syncs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "player_payment_syncs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text NOT NULL,
	"payments_read" integer,
	"payments_written" integer,
	"sender_rows" integer,
	"receiver_rows" integer,
	"creations_read" integer,
	"creation_days_written" integer,
	"duration_ms" integer,
	"source_query_ms" integer,
	"detail" text,
	CONSTRAINT "player_payment_syncs_status_valid" CHECK ("player_payment_syncs"."status" IN ('ok', 'error'))
);
--> statement-breakpoint
CREATE TABLE "player_payments" (
	"transaction_type" text NOT NULL,
	"source" text NOT NULL,
	"receiver" text NOT NULL,
	"amount" integer NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"ordinal" integer NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_payments_transaction_type_source_receiver_amount_occurred_at_ordinal_pk" PRIMARY KEY("transaction_type","source","receiver","amount","occurred_at","ordinal")
);
--> statement-breakpoint
CREATE INDEX "player_payment_syncs_ran_at_idx" ON "player_payment_syncs" USING btree ("ran_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "player_payments_occurred_at_idx" ON "player_payments" USING btree ("occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "player_payments_source_occurred_at_idx" ON "player_payments" USING btree ("source","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "player_payments_receiver_occurred_at_idx" ON "player_payments" USING btree ("receiver","occurred_at" DESC NULLS LAST);
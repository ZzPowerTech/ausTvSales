CREATE TABLE "health_checks" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "health_checks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"check_name" text NOT NULL,
	"status" text NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"detail" jsonb,
	"alerted_at" timestamp with time zone,
	CONSTRAINT "health_checks_status_valid" CHECK ("health_checks"."status" IN ('ok', 'breached', 'no_data', 'error'))
);
--> statement-breakpoint
CREATE INDEX "health_checks_name_checked_at_idx" ON "health_checks" USING btree ("check_name","checked_at" DESC NULLS LAST);
CREATE TABLE "weekly_reports" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "weekly_reports_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"period_from" date NOT NULL,
	"period_to" date NOT NULL,
	"status" text NOT NULL,
	"payload" jsonb,
	"rendered" text,
	"delivered" boolean DEFAULT false NOT NULL,
	"detail" text,
	CONSTRAINT "weekly_reports_status_valid" CHECK ("weekly_reports"."status" IN ('ok', 'error')),
	CONSTRAINT "weekly_reports_period_ordered" CHECK ("weekly_reports"."period_from" <= "weekly_reports"."period_to")
);
--> statement-breakpoint
CREATE INDEX "weekly_reports_generated_at_idx" ON "weekly_reports" USING btree ("generated_at" DESC NULLS LAST);
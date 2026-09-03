CREATE TABLE "suggestion_audit" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "suggestion_audit_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"suggestion_id" integer NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"from_status" text NOT NULL,
	"to_status" text,
	"command" text NOT NULL,
	"reason" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suggestion_audit_action_valid" CHECK ("suggestion_audit"."action" IN ('transition', 'transition_denied', 'auth_denied')),
	CONSTRAINT "suggestion_audit_from_status_valid" CHECK ("suggestion_audit"."from_status" IN ('enviada', 'aprovada', 'em_andamento', 'concluida', 'recusada')),
	CONSTRAINT "suggestion_audit_to_status_valid" CHECK ("suggestion_audit"."to_status" IS NULL OR "suggestion_audit"."to_status" IN ('enviada', 'aprovada', 'em_andamento', 'concluida', 'recusada')),
	CONSTRAINT "suggestion_audit_shape_matches_action" CHECK (("suggestion_audit"."action" = 'transition' AND "suggestion_audit"."to_status" IS NOT NULL AND "suggestion_audit"."reason" IS NULL)
          OR ("suggestion_audit"."action" = 'transition_denied' AND "suggestion_audit"."to_status" IS NOT NULL AND "suggestion_audit"."reason" IS NOT NULL)
          OR ("suggestion_audit"."action" = 'auth_denied' AND "suggestion_audit"."reason" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "suggestion_audit" ADD CONSTRAINT "suggestion_audit_suggestion_id_suggestions_id_fk" FOREIGN KEY ("suggestion_id") REFERENCES "public"."suggestions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "suggestion_audit_suggestion_at_idx" ON "suggestion_audit" USING btree ("suggestion_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "suggestion_audit_actor_at_idx" ON "suggestion_audit" USING btree ("actor","at" DESC NULLS LAST);
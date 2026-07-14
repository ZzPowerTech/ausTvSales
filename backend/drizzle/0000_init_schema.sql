CREATE TABLE "categories" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "categories_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"item_id" text NOT NULL,
	"display_name" text NOT NULL,
	"category_id" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "items_item_id_unique" UNIQUE("item_id")
);
--> statement-breakpoint
CREATE TABLE "players" (
	"uuid" uuid PRIMARY KEY NOT NULL,
	"last_known_nickname" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales" (
	"id" uuid PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"player_uuid" uuid NOT NULL,
	"nickname_at_purchase" text NOT NULL,
	"total_price" numeric(12, 2) NOT NULL,
	"qtd" integer NOT NULL,
	"purchased_at" timestamp with time zone NOT NULL,
	"historical_import" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_qtd_positive" CHECK ("sales"."qtd" > 0),
	CONSTRAINT "sales_total_price_positive" CHECK ("sales"."total_price" > 0)
);
--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_item_id_items_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("item_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_player_uuid_players_uuid_fk" FOREIGN KEY ("player_uuid") REFERENCES "public"."players"("uuid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sales_item_purchased_at_idx" ON "sales" USING btree ("item_id","purchased_at");--> statement-breakpoint
CREATE INDEX "sales_player_item_idx" ON "sales" USING btree ("player_uuid","item_id");
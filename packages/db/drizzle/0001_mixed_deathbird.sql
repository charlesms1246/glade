CREATE TABLE "floor_state" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"peak_usd" numeric(38, 18),
	"last_trade_at" timestamp with time zone,
	"trades_day" date,
	"trades_today" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paper_accounts" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"cash_usd" numeric(38, 18) NOT NULL,
	"funding_hour" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paper_holdings" (
	"user_id" uuid NOT NULL,
	"asset_id" text NOT NULL,
	"qty" numeric(38, 18) NOT NULL,
	CONSTRAINT "paper_holdings_user_id_asset_id_pk" PRIMARY KEY("user_id","asset_id")
);
--> statement-breakpoint
CREATE TABLE "paper_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"amount_usd" numeric(38, 18) NOT NULL,
	"asset_id" text,
	"order_id" text,
	"meta" jsonb
);
--> statement-breakpoint
CREATE TABLE "paper_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"asset_id" text NOT NULL,
	"side" "side" NOT NULL,
	"qty" numeric(38, 18) NOT NULL,
	"qty_unit" text NOT NULL,
	"leverage" integer,
	"reduce_only" boolean NOT NULL,
	"status" text NOT NULL,
	"payload" text NOT NULL,
	"quote_price" numeric(38, 18) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"executed_qty" numeric(38, 18),
	"executed_vwap" numeric(38, 18),
	"fee" numeric(38, 18),
	"failure_reason" text,
	"executed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "paper_positions" (
	"user_id" uuid NOT NULL,
	"asset_id" text NOT NULL,
	"size" numeric(38, 18) NOT NULL,
	"entry_price" numeric(38, 18) NOT NULL,
	"margin" numeric(38, 18) NOT NULL,
	"leverage" integer NOT NULL,
	CONSTRAINT "paper_positions_user_id_asset_id_pk" PRIMARY KEY("user_id","asset_id")
);
--> statement-breakpoint
ALTER TABLE "floor_state" ADD CONSTRAINT "floor_state_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_accounts" ADD CONSTRAINT "paper_accounts_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_holdings" ADD CONSTRAINT "paper_holdings_user_id_paper_accounts_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."paper_accounts"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_ledger" ADD CONSTRAINT "paper_ledger_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_orders" ADD CONSTRAINT "paper_orders_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_positions" ADD CONSTRAINT "paper_positions_user_id_paper_accounts_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."paper_accounts"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paper_ledger_user_at" ON "paper_ledger" USING btree ("user_id","at");--> statement-breakpoint
CREATE INDEX "paper_orders_user" ON "paper_orders" USING btree ("user_id","created_at");
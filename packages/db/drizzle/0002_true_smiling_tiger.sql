CREATE TABLE "paper_equity_snapshots" (
	"user_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"equity_usd" numeric(38, 18) NOT NULL,
	"stock_usd" numeric(38, 18) NOT NULL,
	"hedge_notional_usd" numeric(38, 18) NOT NULL,
	"floor_usd" numeric(38, 18),
	CONSTRAINT "paper_equity_snapshots_user_id_at_pk" PRIMARY KEY("user_id","at")
);
--> statement-breakpoint
ALTER TABLE "paper_equity_snapshots" ADD CONSTRAINT "paper_equity_snapshots_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;
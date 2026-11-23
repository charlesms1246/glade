CREATE TYPE "public"."closure_kind" AS ENUM('weekend', 'holiday', 'overnight');--> statement-breakpoint
CREATE TYPE "public"."hedge_mode" AS ENUM('shield', 'floor', 'bell');--> statement-breakpoint
CREATE TYPE "public"."hedge_status" AS ENUM('planned', 'active', 'unwinding', 'closed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."intent_kind" AS ENUM('open', 'increase', 'decrease', 'close', 'spot_buy', 'spot_sell');--> statement-breakpoint
CREATE TYPE "public"."intent_status" AS ENUM('pending', 'executing', 'done', 'failed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."mandate_status" AS ENUM('active', 'paused', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('created', 'signed', 'submitted', 'complete', 'canceled', 'failed', 'failed_funding', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."side" AS ENUM('buy', 'sell');--> statement-breakpoint
CREATE TYPE "public"."tm_env" AS ENUM('uat', 'prod');--> statement-breakpoint
CREATE TABLE "app_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"display_name" text,
	"country_hint" text,
	"status" text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asset_registry" (
	"env" "tm_env" NOT NULL,
	"asset_id" text NOT NULL,
	"economic_asset_id" text,
	"symbol" text NOT NULL,
	"name" text,
	"chain" text,
	"venue" text,
	"type" text NOT NULL,
	"asset_class" text,
	"max_leverage" integer,
	"order_types" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_registry_env_asset_id_pk" PRIMARY KEY("env","asset_id")
);
--> statement-breakpoint
CREATE TABLE "bell_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"est_gap_usd" numeric(38, 18) NOT NULL,
	"real_gap_usd" numeric(38, 18) NOT NULL,
	"saved_usd" numeric(38, 18) NOT NULL,
	"cost_usd" numeric(38, 18) NOT NULL,
	"accuracy_bp" numeric(38, 18)
);
--> statement-breakpoint
CREATE TABLE "bell_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"close_at" timestamp with time zone NOT NULL,
	"open_at" timestamp with time zone NOT NULL,
	"kind" "closure_kind" NOT NULL,
	CONSTRAINT "bell_sessions_close_at_unique" UNIQUE("close_at")
);
--> statement-breakpoint
CREATE TABLE "bell_snapshots" (
	"session_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"close_px" numeric(38, 18) NOT NULL,
	"mark_px" numeric(38, 18) NOT NULL,
	"basis" numeric(38, 18) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bell_snapshots_session_id_symbol_pk" PRIMARY KEY("session_id","symbol")
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"engine_version" text NOT NULL,
	"inputs" jsonb NOT NULL,
	"outputs" jsonb NOT NULL,
	"action" text NOT NULL,
	"explanation" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hedges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"mode" "hedge_mode" NOT NULL,
	"status" "hedge_status" NOT NULL,
	"target_ratio" numeric(38, 18),
	"legs" jsonb NOT NULL,
	"opened_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"unwind_at" timestamp with time zone,
	"bell_session_id" uuid
);
--> statement-breakpoint
CREATE TABLE "instrument_map" (
	"env" "tm_env" NOT NULL,
	"economic_asset_id" text NOT NULL,
	"perp_asset_id" text NOT NULL,
	"method" text NOT NULL,
	"beta" numeric(38, 18) NOT NULL,
	"r2" numeric(38, 18),
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instrument_map_env_economic_asset_id_pk" PRIMARY KEY("env","economic_asset_id")
);
--> statement-breakpoint
CREATE TABLE "intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"hedge_id" uuid,
	"kind" "intent_kind" NOT NULL,
	"asset_id" text NOT NULL,
	"side" "side" NOT NULL,
	"qty" numeric(38, 18) NOT NULL,
	"qty_unit" text NOT NULL,
	"leverage" numeric(38, 18),
	"reduce_only" boolean DEFAULT false NOT NULL,
	"plan_hash" text,
	"reason" text NOT NULL,
	"inputs" jsonb NOT NULL,
	"status" "intent_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mandates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"floor_pct" numeric(38, 18) NOT NULL,
	"multiplier" numeric(38, 18) NOT NULL,
	"ratchet" boolean NOT NULL,
	"base_usd" numeric(38, 18) NOT NULL,
	"leverage_max" numeric(38, 18) NOT NULL,
	"allowed_perps" jsonb NOT NULL,
	"max_trades_day" integer NOT NULL,
	"status" "mandate_status" NOT NULL,
	"mandate_hash" text NOT NULL,
	"webauthn_assertion" jsonb NOT NULL,
	"signed_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"intent_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"tm_order_id" text,
	"status" "order_status" NOT NULL,
	"executed_qty" numeric(38, 18),
	"avg_price" numeric(38, 18),
	"fee" numeric(38, 18),
	"explorer_url" text,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"final_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "passkeys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" "bytea" NOT NULL,
	"counter" integer DEFAULT 0 NOT NULL,
	"transports" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "passkeys_credential_id_unique" UNIQUE("credential_id")
);
--> statement-breakpoint
CREATE TABLE "price_cache" (
	"symbol" text NOT NULL,
	"asset_class" text NOT NULL,
	"px" numeric(38, 18) NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "price_cache_symbol_asset_class_pk" PRIMARY KEY("symbol","asset_class")
);
--> statement-breakpoint
CREATE TABLE "signer_keys" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"env" "tm_env" NOT NULL,
	"public_key_hex" text NOT NULL,
	"enc_private_key" text NOT NULL,
	"enc_data_key" text NOT NULL,
	"iv" text NOT NULL,
	"data_key_iv" text NOT NULL,
	"alg" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tm_users" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"env" "tm_env" NOT NULL,
	"tm_user_id" text NOT NULL,
	"external_ref_id" text NOT NULL,
	"solana_address" text,
	"evm_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tm_users_external_ref_id_unique" UNIQUE("external_ref_id")
);
--> statement-breakpoint
ALTER TABLE "bell_reports" ADD CONSTRAINT "bell_reports_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bell_reports" ADD CONSTRAINT "bell_reports_session_id_bell_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."bell_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bell_snapshots" ADD CONSTRAINT "bell_snapshots_session_id_bell_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."bell_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hedges" ADD CONSTRAINT "hedges_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hedges" ADD CONSTRAINT "hedges_bell_session_id_bell_sessions_id_fk" FOREIGN KEY ("bell_session_id") REFERENCES "public"."bell_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intents" ADD CONSTRAINT "intents_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intents" ADD CONSTRAINT "intents_hedge_id_hedges_id_fk" FOREIGN KEY ("hedge_id") REFERENCES "public"."hedges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_intent_id_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkeys" ADD CONSTRAINT "passkeys_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signer_keys" ADD CONSTRAINT "signer_keys_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tm_users" ADD CONSTRAINT "tm_users_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_registry_lookup" ON "asset_registry" USING btree ("env","symbol","type");--> statement-breakpoint
CREATE UNIQUE INDEX "bell_reports_user_session" ON "bell_reports" USING btree ("user_id","session_id");--> statement-breakpoint
CREATE INDEX "decisions_user_at" ON "decisions" USING btree ("user_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "mandates_user_version" ON "mandates" USING btree ("user_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "mandates_one_active" ON "mandates" USING btree ("user_id") WHERE status = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "orders_intent_attempt" ON "orders" USING btree ("intent_id","attempt");
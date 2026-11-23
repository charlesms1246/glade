import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });
// Amounts are numeric in Postgres and strings in TypeScript (fed to decimal.js).
const money = (name: string) => numeric(name, { precision: 38, scale: 18 });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const tmEnv = pgEnum("tm_env", ["uat", "prod"]);
export const hedgeMode = pgEnum("hedge_mode", ["shield", "floor", "bell"]);
export const hedgeStatus = pgEnum("hedge_status", ["planned", "active", "unwinding", "closed", "failed"]);
export const mandateStatus = pgEnum("mandate_status", ["active", "paused", "revoked"]);
export const intentKind = pgEnum("intent_kind", ["open", "increase", "decrease", "close", "spot_buy", "spot_sell"]);
export const intentStatus = pgEnum("intent_status", ["pending", "executing", "done", "failed", "rejected"]);
export const side = pgEnum("side", ["buy", "sell"]);
export const orderStatus = pgEnum("order_status", [
  "created",
  "signed",
  "submitted",
  "complete",
  "canceled",
  "failed",
  "failed_funding",
  "unknown",
]);
export const closureKind = pgEnum("closure_kind", ["weekend", "holiday", "overnight"]);

export const appUsers = pgTable("app_users", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: ts("created_at").notNull().defaultNow(),
  displayName: text("display_name"),
  countryHint: text("country_hint"),
  status: text("status").notNull().default("active"),
});

export const passkeys = pgTable("passkeys", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => appUsers.id),
  credentialId: text("credential_id").notNull().unique(),
  publicKey: bytea("public_key").notNull(),
  counter: integer("counter").notNull().default(0),
  transports: jsonb("transports").$type<string[]>(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const tmUsers = pgTable("tm_users", {
  userId: uuid("user_id").primaryKey().references(() => appUsers.id),
  env: tmEnv("env").notNull(),
  tmUserId: text("tm_user_id").notNull(),
  externalRefId: text("external_ref_id").notNull().unique(),
  solanaAddress: text("solana_address"),
  evmAddress: text("evm_address"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const signerKeys = pgTable("signer_keys", {
  userId: uuid("user_id").primaryKey().references(() => appUsers.id),
  env: tmEnv("env").notNull(),
  publicKeyHex: text("public_key_hex").notNull(),
  encPrivateKey: text("enc_private_key").notNull(),
  encDataKey: text("enc_data_key").notNull(),
  iv: text("iv").notNull(),
  dataKeyIv: text("data_key_iv").notNull(),
  alg: text("alg").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  revokedAt: ts("revoked_at"),
});

export const assetRegistry = pgTable(
  "asset_registry",
  {
    env: tmEnv("env").notNull(),
    assetId: text("asset_id").notNull(),
    economicAssetId: text("economic_asset_id"),
    symbol: text("symbol").notNull(),
    name: text("name"),
    chain: text("chain"),
    venue: text("venue"),
    type: text("type").notNull(),
    assetClass: text("asset_class"),
    maxLeverage: integer("max_leverage"),
    orderTypes: jsonb("order_types").$type<string[]>(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.env, t.assetId] }),
    index("asset_registry_lookup").on(t.env, t.symbol, t.type),
  ],
);

export const instrumentMap = pgTable(
  "instrument_map",
  {
    env: tmEnv("env").notNull(),
    economicAssetId: text("economic_asset_id").notNull(),
    perpAssetId: text("perp_asset_id").notNull(),
    method: text("method").notNull(),
    beta: money("beta").notNull(),
    r2: money("r2"),
    computedAt: ts("computed_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.env, t.economicAssetId] })],
);

export const mandates = pgTable(
  "mandates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => appUsers.id),
    version: integer("version").notNull(),
    floorPct: money("floor_pct").notNull(),
    multiplier: money("multiplier").notNull(),
    ratchet: boolean("ratchet").notNull(),
    baseUsd: money("base_usd").notNull(),
    leverageMax: money("leverage_max").notNull(),
    allowedPerps: jsonb("allowed_perps").$type<string[]>().notNull(),
    maxTradesDay: integer("max_trades_day").notNull(),
    status: mandateStatus("status").notNull(),
    mandateHash: text("mandate_hash").notNull(),
    webauthnAssertion: jsonb("webauthn_assertion").notNull(),
    signedAt: ts("signed_at").notNull(),
    revokedAt: ts("revoked_at"),
  },
  (t) => [
    uniqueIndex("mandates_user_version").on(t.userId, t.version),
    // At most one active mandate per user.
    uniqueIndex("mandates_one_active").on(t.userId).where(sql`status = 'active'`),
  ],
);

export const bellSessions = pgTable("bell_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  closeAt: ts("close_at").notNull().unique(),
  openAt: ts("open_at").notNull(),
  kind: closureKind("kind").notNull(),
});

export const hedges = pgTable("hedges", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => appUsers.id),
  mode: hedgeMode("mode").notNull(),
  status: hedgeStatus("status").notNull(),
  targetRatio: money("target_ratio"),
  legs: jsonb("legs").notNull(),
  openedAt: ts("opened_at"),
  closedAt: ts("closed_at"),
  unwindAt: ts("unwind_at"),
  bellSessionId: uuid("bell_session_id").references(() => bellSessions.id),
});

export const intents = pgTable("intents", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => appUsers.id),
  hedgeId: uuid("hedge_id").references(() => hedges.id),
  kind: intentKind("kind").notNull(),
  assetId: text("asset_id").notNull(),
  side: side("side").notNull(),
  qty: money("qty").notNull(),
  qtyUnit: text("qty_unit").notNull(),
  leverage: money("leverage"),
  reduceOnly: boolean("reduce_only").notNull().default(false),
  planHash: text("plan_hash"),
  reason: text("reason").notNull(),
  inputs: jsonb("inputs").notNull(),
  status: intentStatus("status").notNull().default("pending"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    intentId: uuid("intent_id").notNull().references(() => intents.id),
    attempt: integer("attempt").notNull(),
    tmOrderId: text("tm_order_id"),
    status: orderStatus("status").notNull(),
    executedQty: money("executed_qty"),
    avgPrice: money("avg_price"),
    fee: money("fee"),
    explorerUrl: text("explorer_url"),
    raw: jsonb("raw"),
    createdAt: ts("created_at").notNull().defaultNow(),
    finalAt: ts("final_at"),
  },
  (t) => [uniqueIndex("orders_intent_attempt").on(t.intentId, t.attempt)],
);

export const decisions = pgTable(
  "decisions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: uuid("user_id").references(() => appUsers.id),
    at: ts("at").notNull().defaultNow(),
    engineVersion: text("engine_version").notNull(),
    inputs: jsonb("inputs").notNull(),
    outputs: jsonb("outputs").notNull(),
    action: text("action").notNull(),
    explanation: text("explanation").notNull(),
  },
  (t) => [index("decisions_user_at").on(t.userId, t.at)],
);

export const bellSnapshots = pgTable(
  "bell_snapshots",
  {
    sessionId: uuid("session_id").notNull().references(() => bellSessions.id),
    // Normalised group symbol (e.g. NVDA for NVDAC/NVDAx holdings).
    symbol: text("symbol").notNull(),
    closePx: money("close_px").notNull(),
    markPx: money("mark_px").notNull(),
    basis: money("basis").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.symbol] })],
);

export const bellReports = pgTable(
  "bell_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => appUsers.id),
    sessionId: uuid("session_id").notNull().references(() => bellSessions.id),
    estGapUsd: money("est_gap_usd").notNull(),
    realGapUsd: money("real_gap_usd").notNull(),
    savedUsd: money("saved_usd").notNull(),
    costUsd: money("cost_usd").notNull(),
    accuracyBp: money("accuracy_bp"),
  },
  (t) => [uniqueIndex("bell_reports_user_session").on(t.userId, t.sessionId)],
);

export const priceCache = pgTable(
  "price_cache",
  {
    symbol: text("symbol").notNull(),
    assetClass: text("asset_class").notNull(),
    px: money("px").notNull(),
    at: ts("at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.symbol, t.assetClass] })],
);

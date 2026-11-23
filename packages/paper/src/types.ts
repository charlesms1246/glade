import type { Decimal } from "@glade/shared";

export type AssetClassKind = "spot" | "perp";

/** What the paper venue needs to know about an asset id. */
export interface PaperAsset {
  assetId: string;
  symbol: string;
  type: AssetClassKind;
  assetClass: "stock" | "crypto";
  maxLeverage: number | null;
  economicAssetId: string | null;
  venue: string | null;
  chain: string | null;
}

/** Live price for a symbol (injected; the paper venue never fetches on its own). */
export type PriceProvider = (symbol: string, cls: AssetClassKind) => Promise<Decimal>;
export type AssetRegistry = (assetId: string) => Promise<PaperAsset | null>;

export interface PaperPosition {
  assetId: string;
  /** Short size in base units, always > 0. */
  size: string;
  entryPrice: string;
  /** Isolated margin posted, USD. */
  margin: string;
  leverage: number;
}

/** One user's paper account. Amounts are decimal strings. */
export interface PaperState {
  cashUsd: string;
  holdings: Record<string, string>;
  positions: Record<string, PaperPosition>;
  /** Last funding hour applied (floor(epoch ms / 3600000)), or null. */
  fundingHour: number | null;
}

export type PaperOrderStatus = "initialized" | "complete" | "canceled" | "failed";

export interface PaperOrder {
  id: string;
  userId: string;
  assetId: string;
  side: "buy" | "sell";
  qty: string;
  qtyUnit: "base" | "quote";
  leverage: number | null;
  reduceOnly: boolean;
  status: PaperOrderStatus;
  payload: string;
  quotePrice: string;
  createdAt: number;
  executedQty: string | null;
  executedVwap: string | null;
  fee: string | null;
  failureReason: string | null;
  executedAt: number | null;
}

export type LedgerKind = "deposit" | "spot_trade" | "perp_margin" | "realized_pnl" | "fee" | "funding";

export interface LedgerEntry {
  kind: LedgerKind;
  /** Signed change to paper cash, USD. */
  amountUsd: string;
  assetId: string | null;
  orderId: string | null;
  at: number;
  meta?: Record<string, unknown>;
}

export interface TxResult<T> {
  state: PaperState;
  ledger: LedgerEntry[];
  orders?: PaperOrder[];
  result: T;
}

export interface PaperTx {
  getOrder(orderId: string): Promise<PaperOrder | null>;
}

export interface PaperRepo {
  /** Compressed P-256 signer public key (hex) the user stamps with, or null. */
  signerPublicKey(userId: string): Promise<string | null>;
  /** Null when the user has no paper account yet. */
  load(userId: string): Promise<PaperState | null>;
  /**
   * Lock the user's account, run fn on its current state (null when none exists), then save
   * the new state, ledger rows and order upserts in one transaction. fn returning null aborts.
   */
  update<T>(userId: string, fn: (state: PaperState | null, tx: PaperTx) => Promise<TxResult<T> | null>): Promise<T | null>;
  insertOrder(order: PaperOrder): Promise<void>;
  getOrder(orderId: string): Promise<PaperOrder | null>;
}

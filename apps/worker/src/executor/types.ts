import type { CheckResult } from "@glade/engine";
import type { Side, TmEnv } from "@glade/shared";
import type { SignerKey } from "@glade/stamp";

export interface ExecIntent {
  id: string;
  userId: string;
  /** True Markets user id (TM-On-Behalf-Of). */
  tmUserId: string;
  assetId: string;
  side: Side;
  qty: string;
  qtyUnit: "base" | "quote";
  leverage: number | null;
  reduceOnly: boolean;
  /** USD notional used for caps; computed by the planner. */
  notionalUsd: string;
  venue: "defi" | "cefi" | "smart";
}

export type OrderRowStatus =
  | "created"
  | "signed"
  | "submitted"
  | "complete"
  | "canceled"
  | "failed"
  | "failed_funding"
  | "unknown";

export interface OrderRow {
  intentId: string;
  attempt: number;
  tmOrderId: string | null;
  status: OrderRowStatus;
  executedQty?: string | null;
  avgPrice?: string | null;
  fee?: string | null;
  explorerUrl?: string | null;
  raw?: unknown;
}

export interface ExecutorRepo {
  listOrders(intentId: string): Promise<OrderRow[]>;
  /** Must fail if (intentId, attempt) already exists. */
  insertOrder(row: OrderRow): Promise<void>;
  updateOrder(intentId: string, attempt: number, patch: Partial<OrderRow>): Promise<void>;
  setIntentStatus(intentId: string, status: "executing" | "done" | "failed" | "rejected"): Promise<void>;
}

export interface ExecutorConfig {
  tmEnv: TmEnv;
  maxOrderUsd: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

export interface ExecutorDeps {
  repo: ExecutorRepo;
  /** Signing policy for this intent (mandate or fresh user approval). Called before create and before stamping. */
  authorize: (intent: ExecIntent) => Promise<CheckResult>;
  signerFor: (userId: string) => Promise<SignerKey>;
  config: ExecutorConfig;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export type ExecResult =
  | { outcome: "complete"; tmOrderId: string; row: OrderRow }
  | { outcome: "failed"; reason: string; row?: OrderRow }
  | { outcome: "rejected"; reasons: string[] }
  | { outcome: "unknown"; tmOrderId: string };

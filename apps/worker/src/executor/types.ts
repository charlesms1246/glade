import type { CheckResult } from "@glade/engine";
import type { CreateOrderRequest, CreateOrderResponse, OrderDetail } from "@glade/tm-client";
import type { Side, TmEnv } from "@glade/shared";
import type { SignerKey } from "@glade/stamp";

export interface ExecIntent {
  id: string;
  userId: string;
  /** The id the venue knows the user by: the True Markets user id on UAT, the app user id on paper. */
  venueUserId: string;
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

/** The slice of the True Markets user API the Executor needs. A TmClient and the paper venue both fit. */
export interface ExecVenueUser {
  createOrder(body: CreateOrderRequest): Promise<CreateOrderResponse>;
  executeOrder(orderId: string, signatures: string[]): Promise<unknown>;
  getOrder(orderId: string): Promise<OrderDetail>;
}

export interface ExecVenue {
  /** "paper" only on the simulated venue; a real True Markets client has no kind. */
  readonly kind?: "paper";
  forUser(venueUserId: string): ExecVenueUser;
}

export interface ExecutorConfig {
  /** Where orders go: the paper venue (simulated) or True Markets UAT (paper funds). */
  venue: "paper" | "uat";
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

import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { dec, type Decimal } from "@glade/shared";
import {
  TmApiError,
  type CreateOrderRequest,
  type CreateOrderResponse,
  type OrderDetail,
  type Portfolio,
  type PortfolioBalance,
  type Position,
} from "@glade/tm-client";
import { z } from "zod";
import { applyFill, applyFunding, emptyState, fx, positionView, QUOTE_TTL_MS, type FillReason } from "./core";
import type { AssetRegistry, LedgerEntry, PaperOrder, PaperRepo, PaperState, PriceProvider } from "./types";

const STAMP_SCHEME = "SIGNATURE_SCHEME_TK_API_P256";
// SPKI DER prefix for a compressed P-256 point.
const SPKI_P256_COMPRESSED = Buffer.from("3039301306072a8648ce3d020106082a8648ce3d030107032200", "hex");

const stampEnvelope = z.object({
  publicKey: z.string().regex(/^0[23][0-9a-fA-F]{64}$/),
  signature: z.string().regex(/^[0-9a-fA-F]+$/),
  scheme: z.literal(STAMP_SCHEME),
});

const fail = (status: number, type: string, code: string, message: string, path: string, method = "POST") =>
  new TmApiError(status, { type, code, message, request_id: `paper_${randomUUID()}` }, method, path);

/** Verify a base64url stamp envelope over the exact payload against the expected signer key. */
export function verifyStamp(stamp: string, payload: string, expectedPublicKeyHex: string): boolean {
  let env: z.infer<typeof stampEnvelope>;
  try {
    env = stampEnvelope.parse(JSON.parse(Buffer.from(stamp, "base64url").toString("utf8")));
  } catch {
    return false;
  }
  if (env.publicKey.toLowerCase() !== expectedPublicKeyHex.toLowerCase()) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([SPKI_P256_COMPRESSED, Buffer.from(env.publicKey, "hex")]),
      format: "der",
      type: "spki",
    });
    return verify("sha256", Buffer.from(payload, "utf8"), key, Buffer.from(env.signature, "hex"));
  } catch {
    return false;
  }
}

/** Canonical payload: sorted-key JSON with a trailing newline, like the strings True Markets returns. */
function canonicalPayload(fields: Record<string, unknown>): string {
  const sorted = Object.fromEntries(Object.keys(fields).sort().map((k) => [k, fields[k]]));
  return `${JSON.stringify(sorted)}\n`;
}

export interface PaperVenueOptions {
  repo: PaperRepo;
  prices: PriceProvider;
  registry: AssetRegistry;
  now?: () => number;
}

const USDC = { symbol: "USDC", venue: "paper", chain: null, stable: true, tradeable: true } as const;
const HOUR_MS = 3_600_000;

/**
 * A simulated True Markets user API on live prices. Nothing here can reach True Markets: prices
 * come from the injected provider and all state lives in the repo. Mirrors Glade's policy too:
 * long perps and reduce-only flips are refused.
 */
export function createPaperVenue(opts: PaperVenueOptions) {
  const { repo, prices, registry } = opts;
  const now = opts.now ?? Date.now;

  async function asset(assetId: string | undefined, path: string, method = "POST") {
    const a = assetId ? await registry(assetId) : null;
    if (!a) throw fail(404, "not_found", "asset_not_found", `unknown asset ${assetId ?? "-"}`, path, method);
    return a;
  }

  const rejectReason = (reason: FillReason, path: string) =>
    fail(400, "invalid_request", reason, `paper venue rejected the order: ${reason}`, path);

  const stamped = (entries: Omit<LedgerEntry, "orderId" | "at">[], orderId: string | null, at: number): LedgerEntry[] =>
    entries.map((e) => ({ ...e, orderId, at }));

  const orderDetail = (o: PaperOrder, type: "spot" | "perp"): OrderDetail => ({
    order_id: o.id,
    asset_id: o.assetId,
    side: o.side,
    status: o.status,
    qty: o.qty,
    executed_qty: o.executedQty,
    executed_vwap: o.executedVwap,
    fee: o.fee,
    ...(o.failureReason ? { failure_reason: o.failureReason } : {}),
    asset_type: type,
  });

  async function positionsOf(state: PaperState): Promise<Position[]> {
    const out: Position[] = [];
    for (const p of Object.values(state.positions)) {
      const a = await registry(p.assetId);
      if (!a) continue;
      out.push(positionView(p, a, await prices(a.symbol, "perp")));
    }
    return out;
  }

  async function portfolioOf(state: PaperState | null): Promise<Portfolio> {
    const s = state ?? emptyState();
    const cash = dec(s.cashUsd);
    const balances: PortfolioBalance[] = [{ ...USDC, total: fx(cash), available: fx(cash), price: "1", value: fx(cash) }];
    let total = cash;
    for (const [assetId, qty] of Object.entries(s.holdings)) {
      const a = await registry(assetId);
      if (!a) continue;
      const px = await prices(a.symbol, "spot");
      const value = dec(qty).mul(px);
      total = total.plus(value);
      balances.push({
        asset_id: assetId,
        ...(a.economicAssetId ? { economic_asset_id: a.economicAssetId } : {}),
        symbol: a.symbol,
        venue: a.venue ?? "paper",
        chain: a.chain,
        stable: false,
        tradeable: true,
        total: qty,
        available: qty,
        price: fx(px),
        value: fx(value),
      });
    }
    const positions = await positionsOf(s);
    for (const p of positions) total = total.plus(dec(p.margin_used ?? "0")).plus(dec(p.unrealized_pnl ?? "0"));
    return { total_usd: fx(total), cash_usd: fx(cash), balances, positions };
  }

  function forUser(userId: string) {
    return {
      async createOrder(body: CreateOrderRequest): Promise<CreateOrderResponse> {
        const path = "/orders";
        if (body.type !== "market") throw fail(400, "invalid_request", "unsupported_order_type", "paper venue fills market orders only", path);
        const a = await asset(body.asset_id, path);
        const price = await prices(a.symbol, a.type);
        const spec = {
          side: body.side,
          qty: body.qty,
          qtyUnit: body.qty_unit,
          leverage: body.leverage ?? null,
          reduceOnly: body.reduce_only ?? false,
        };
        if (a.type === "spot" && spec.leverage !== null) throw rejectReason("leverage_out_of_range", path);
        const state = await repo.load(userId);
        const dry = applyFill(state ?? emptyState(), a, spec, price);
        if (!dry.ok) {
          if (dry.reason === "insufficient_balance") return { order_id: "", quote: { issues: ["insufficient_balance"] } };
          throw rejectReason(dry.reason, path);
        }
        const id = `paper_${randomUUID()}`;
        const createdAt = now();
        const payload = canonicalPayload({
          type: "PAPER_ORDER",
          order_id: id,
          user_id: userId,
          asset_id: a.assetId,
          side: spec.side,
          qty: spec.qty,
          qty_unit: spec.qtyUnit,
          leverage: spec.leverage,
          reduce_only: spec.reduceOnly,
          quote_price: fx(price),
          created_at: new Date(createdAt).toISOString(),
        });
        await repo.insertOrder({
          id,
          userId,
          assetId: a.assetId,
          ...spec,
          status: "initialized",
          payload,
          quotePrice: fx(price),
          createdAt,
          executedQty: null,
          executedVwap: null,
          fee: null,
          failureReason: null,
          executedAt: null,
        });
        return {
          order_id: id,
          status: "initialized",
          payloads: [{ digest: createHash("sha256").update(payload, "utf8").digest("hex"), payload }],
          quote: { qty: dry.fill.qty, qty_out: dry.fill.qty, fee: dry.fill.fee, fee_asset: "USDC", issues: [] },
        };
      },

      async executeOrder(orderId: string, signatures: string[]): Promise<{ order_id: string; status: string }> {
        const path = "/orders/{id}/execute";
        const o = await repo.getOrder(orderId);
        if (!o || o.userId !== userId) throw fail(404, "not_found", "order_not_found", "order not found", path);
        if (o.status !== "initialized") throw fail(409, "conflict", "already_submitted", "order already submitted", path);
        const pub = await repo.signerPublicKey(userId);
        if (!pub || signatures.length !== 1 || !verifyStamp(signatures[0]!, o.payload, pub)) {
          throw fail(401, "unauthenticated", "invalid_signature", "signature does not verify", path);
        }
        const a = await asset(o.assetId, path);
        const price = await prices(a.symbol, a.type);
        const at = now();
        const res = await repo.update(userId, async (state, tx) => {
          const cur = await tx.getOrder(orderId);
          if (!cur || cur.status !== "initialized") return null;
          if (at - cur.createdAt > QUOTE_TTL_MS) {
            return { state: state ?? emptyState(), ledger: [], orders: [{ ...cur, status: "failed", failureReason: "quote_stale", executedAt: at }], result: "stale" as const };
          }
          const fill = applyFill(state ?? emptyState(), a, cur, price);
          if (!fill.ok) {
            return { state: state ?? emptyState(), ledger: [], orders: [{ ...cur, status: "failed", failureReason: fill.reason, executedAt: at }], result: "failed" as const };
          }
          const done: PaperOrder = {
            ...cur,
            status: "complete",
            executedQty: fill.fill.qty,
            executedVwap: fill.fill.vwap,
            fee: fill.fill.fee,
            executedAt: at,
          };
          return { state: fill.state, ledger: stamped(fill.ledger, orderId, at), orders: [done], result: "complete" as const };
        });
        if (res === null) throw fail(409, "conflict", "already_submitted", "order already submitted", path);
        if (res === "stale") throw fail(422, "failed_precondition", "quote_stale", "quote expired; create a new order", path);
        return { order_id: orderId, status: res === "complete" ? "pending" : "failed" };
      },

      async getOrder(orderId: string): Promise<OrderDetail> {
        const o = await repo.getOrder(orderId);
        if (!o || o.userId !== userId) throw fail(404, "not_found", "order_not_found", "order not found", "/orders/{id}", "GET");
        const a = await registry(o.assetId);
        return orderDetail(o, a?.type ?? "spot");
      },

      async cancelOrder(orderId: string): Promise<CreateOrderResponse> {
        const path = "/orders/{id}/cancel";
        const res = await repo.update(userId, async (state, tx) => {
          const cur = await tx.getOrder(orderId);
          if (!cur || cur.userId !== userId) return null;
          if (cur.status !== "initialized") return { state: state ?? emptyState(), ledger: [], result: cur.status };
          return { state: state ?? emptyState(), ledger: [], orders: [{ ...cur, status: "canceled" }], result: "canceled" as const };
        });
        if (res === null) throw fail(404, "not_found", "order_not_found", "order not found", path);
        if (res !== "canceled") throw fail(409, "conflict", "not_cancelable", `order is ${res}`, path);
        return { order_id: orderId, status: "canceled", payloads: [] };
      },

      async portfolio(): Promise<Portfolio> {
        return portfolioOf(await repo.load(userId));
      },

      async positions(): Promise<{ positions: Position[] }> {
        return { positions: await positionsOf((await repo.load(userId)) ?? emptyState()) };
      },

      async balances(): Promise<{ balances: PortfolioBalance[] }> {
        return { balances: (await portfolioOf(await repo.load(userId))).balances };
      },
    };
  }

  /** Paper deposit (explicit top-up). Never touches real funds. */
  async function fundPaper(userId: string, usd: string): Promise<string> {
    const amount = dec(usd);
    if (!amount.isFinite() || amount.lte(0)) throw new Error("paper deposit must be positive");
    const at = now();
    const cash = await repo.update(userId, async (state) => {
      const s = state ?? emptyState();
      const cashUsd = fx(dec(s.cashUsd).plus(amount));
      return { state: { ...s, cashUsd }, ledger: [{ kind: "deposit", amountUsd: fx(amount), assetId: null, orderId: null, at }], result: cashUsd };
    });
    return cash!;
  }

  /** Create the paper account with `initialUsd` only if none exists. Returns true when it created one. */
  async function ensurePaperAccount(userId: string, initialUsd: string): Promise<boolean> {
    const amount = dec(initialUsd);
    if (!amount.isFinite() || amount.lt(0)) throw new Error("initial paper balance must be >= 0");
    const at = now();
    const created = await repo.update(userId, async (state) => {
      if (state) return null;
      const ledger: LedgerEntry[] = amount.gt(0) ? [{ kind: "deposit", amountUsd: fx(amount), assetId: null, orderId: null, at }] : [];
      return { state: { ...emptyState(), cashUsd: fx(amount) }, ledger, result: true };
    });
    return created === true;
  }

  /**
   * Settle this hour's funding for the user's shorts. `hourlyRates` maps perp symbol → hourly
   * funding rate (positive means shorts receive). Idempotent per hour.
   */
  async function accrueFunding(userId: string, hourlyRates: Record<string, Decimal | string>, at = now()): Promise<LedgerEntry[]> {
    const hour = Math.floor(at / HOUR_MS);
    const state = await repo.load(userId);
    if (!state || (state.fundingHour !== null && state.fundingHour >= hour)) return [];
    const marks: Record<string, { rate: Decimal; mark: Decimal }> = {};
    for (const p of Object.values(state.positions)) {
      const a = await registry(p.assetId);
      const r = a ? hourlyRates[a.symbol] : undefined;
      if (!a || r === undefined) continue;
      marks[p.assetId] = { rate: dec(r), mark: await prices(a.symbol, "perp") };
    }
    const out = await repo.update(userId, async (cur) => {
      if (!cur) return null;
      const res = applyFunding(cur, hour, marks);
      if (res.state === cur) return null;
      const ledger = stamped(res.ledger, null, at);
      return { state: res.state, ledger, result: ledger };
    });
    return out ?? [];
  }

  return { kind: "paper" as const, forUser, fundPaper, ensurePaperAccount, accrueFunding, portfolioOf };
}

export type PaperVenue = ReturnType<typeof createPaperVenue>;
export type PaperUserClient = ReturnType<PaperVenue["forUser"]>;

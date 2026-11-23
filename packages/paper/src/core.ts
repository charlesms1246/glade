import { Decimal, dec, dmax, dmin, ZERO } from "@glade/shared";
import type { Position } from "@glade/tm-client";
import type { LedgerEntry, PaperAsset, PaperPosition, PaperState } from "./types";

// [assumption] Paper fees, in basis points of notional. Not published True Markets numbers.
export const PERP_FEE_BP = dec("4.5");
export const SPOT_FEE_BP = dec("10");
// [assumption] Used when the registry has no max_leverage for a perp.
export const DEFAULT_MAX_LEVERAGE = 10;
export const QUOTE_TTL_MS = 120_000;

const BP = dec(10_000);

/** Fixed-point string at the database scale (18 dp), rounded toward zero, never exponent notation. */
export const fx = (d: Decimal): string => d.toDecimalPlaces(18, Decimal.ROUND_DOWN).toFixed();

export const emptyState = (): PaperState => ({ cashUsd: "0", holdings: {}, positions: {}, fundingHour: null });

export interface OrderSpec {
  side: "buy" | "sell";
  qty: string;
  qtyUnit: "base" | "quote";
  leverage: number | null;
  reduceOnly: boolean;
}

export interface Fill {
  qty: string;
  vwap: string;
  fee: string;
}

/** insufficient_balance is reported as a quote issue; every other reason is a rejected request. */
export type FillReason =
  | "insufficient_balance"
  | "invalid_qty"
  | "invalid_price"
  | "leverage_required"
  | "leverage_out_of_range"
  | "long_perp_not_allowed"
  | "reduce_only_sell_not_allowed"
  | "no_position"
  | "reduce_only_would_flip"
  | "reduce_only_spot";

export type FillOutcome =
  | { ok: true; state: PaperState; ledger: Omit<LedgerEntry, "orderId" | "at">[]; fill: Fill }
  | { ok: false; reason: FillReason };

const maxLev = (a: PaperAsset) => a.maxLeverage ?? DEFAULT_MAX_LEVERAGE;

/**
 * [assumption] Maintenance margin rate = 1 / (2 · max_leverage). A short is liquidated when the mark
 * reaches entry · (1 + 1/L − mmr), where L = notional at entry / margin posted.
 */
export function liquidationPrice(p: PaperPosition, asset: PaperAsset): Decimal {
  const entry = dec(p.entryPrice);
  const margin = dec(p.margin);
  const notional = dec(p.size).mul(entry);
  if (notional.lte(0)) return ZERO;
  const mmr = dec(1).div(2 * maxLev(asset));
  return entry.mul(dec(1).plus(margin.div(notional)).minus(mmr));
}

/** Apply a market fill at `price` to a copy of the state. Pure: no I/O, no clock. */
export function applyFill(state: PaperState, asset: PaperAsset, o: OrderSpec, price: Decimal): FillOutcome {
  const qty = dec(o.qty);
  if (!qty.isFinite() || qty.lte(0)) return { ok: false, reason: "invalid_qty" };
  if (!price.isFinite() || price.lte(0)) return { ok: false, reason: "invalid_price" };
  const base = o.qtyUnit === "base" ? qty : qty.div(price);
  const cash = dec(state.cashUsd);
  const next: PaperState = { ...state, holdings: { ...state.holdings }, positions: { ...state.positions } };
  const id = asset.assetId;

  if (asset.type === "spot") {
    if (o.reduceOnly) return { ok: false, reason: "reduce_only_spot" };
    const held = dec(state.holdings[id] ?? "0");
    if (o.side === "buy") {
      // A quote-denominated buy spends exactly qty USD, fee included.
      const gross = o.qtyUnit === "quote" ? qty : base.mul(price).mul(BP.plus(SPOT_FEE_BP)).div(BP);
      const fee = gross.mul(SPOT_FEE_BP).div(BP.plus(SPOT_FEE_BP));
      const got = gross.minus(fee).div(price);
      if (gross.gt(cash)) return { ok: false, reason: "insufficient_balance" };
      next.cashUsd = fx(cash.minus(gross));
      next.holdings[id] = fx(held.plus(got));
      return {
        ok: true,
        state: next,
        ledger: [
          { kind: "spot_trade", amountUsd: fx(gross.minus(fee).neg()), assetId: id },
          { kind: "fee", amountUsd: fx(fee.neg()), assetId: id },
        ],
        fill: { qty: fx(got), vwap: fx(price), fee: fx(fee) },
      };
    }
    if (base.gt(held)) return { ok: false, reason: "insufficient_balance" };
    const proceeds = base.mul(price);
    const fee = proceeds.mul(SPOT_FEE_BP).div(BP);
    next.cashUsd = fx(cash.plus(proceeds).minus(fee));
    const left = held.minus(base);
    if (left.lte(0)) delete next.holdings[id];
    else next.holdings[id] = fx(left);
    return {
      ok: true,
      state: next,
      ledger: [
        { kind: "spot_trade", amountUsd: fx(proceeds), assetId: id },
        { kind: "fee", amountUsd: fx(fee.neg()), assetId: id },
      ],
      fill: { qty: fx(base), vwap: fx(price), fee: fx(fee) },
    };
  }

  // Perps: Glade only ever holds shorts. Sell opens or increases; reduce-only buy decreases.
  const pos = state.positions[id];
  const notional = base.mul(price);
  const fee = notional.mul(PERP_FEE_BP).div(BP);
  if (o.side === "sell") {
    if (o.reduceOnly) return { ok: false, reason: "reduce_only_sell_not_allowed" };
    // An increase keeps the position's leverage (isolated margin).
    const lev = pos ? pos.leverage : o.leverage;
    if (lev === null) return { ok: false, reason: "leverage_required" };
    if (!Number.isInteger(lev) || lev < 1 || lev > maxLev(asset)) return { ok: false, reason: "leverage_out_of_range" };
    const margin = notional.div(lev);
    if (margin.plus(fee).gt(cash)) return { ok: false, reason: "insufficient_balance" };
    const oldSize = dec(pos?.size ?? "0");
    const size = oldSize.plus(base);
    const entry = oldSize.mul(dec(pos?.entryPrice ?? "0")).plus(notional).div(size);
    next.cashUsd = fx(cash.minus(margin).minus(fee));
    next.positions[id] = {
      assetId: id,
      size: fx(size),
      entryPrice: fx(entry),
      margin: fx(dec(pos?.margin ?? "0").plus(margin)),
      leverage: lev,
    };
    return {
      ok: true,
      state: next,
      ledger: [
        { kind: "perp_margin", amountUsd: fx(margin.neg()), assetId: id },
        { kind: "fee", amountUsd: fx(fee.neg()), assetId: id },
      ],
      fill: { qty: fx(base), vwap: fx(price), fee: fx(fee) },
    };
  }

  if (!o.reduceOnly) return { ok: false, reason: "long_perp_not_allowed" };
  if (!pos) return { ok: false, reason: "no_position" };
  const size = dec(pos.size);
  if (base.gt(size)) return { ok: false, reason: "reduce_only_would_flip" };
  const margin = dec(pos.margin);
  const released = margin.mul(base).div(size);
  // Isolated margin: the loss on the closed part never exceeds the margin it releases.
  const pnl = dmax(dec(pos.entryPrice).minus(price).mul(base), released.neg());
  const paidFee = dmin(fee, cash.plus(released).plus(pnl));
  next.cashUsd = fx(cash.plus(released).plus(pnl).minus(paidFee));
  const left = size.minus(base);
  if (left.lte(0)) delete next.positions[id];
  else next.positions[id] = { ...pos, size: fx(left), margin: fx(margin.minus(released)) };
  return {
    ok: true,
    state: next,
    ledger: [
      { kind: "perp_margin", amountUsd: fx(released), assetId: id },
      { kind: "realized_pnl", amountUsd: fx(pnl), assetId: id },
      { kind: "fee", amountUsd: fx(paidFee.neg()), assetId: id },
    ],
    fill: { qty: fx(base), vwap: fx(price), fee: fx(paidFee) },
  };
}

/**
 * Settle one funding hour into each short's isolated margin. `hourlyRate` is True Markets'
 * perp.funding_rate (hourly; positive means shorts receive). Applies at most once per hour;
 * missed hours are not back-filled. Margin never goes below zero.
 */
export function applyFunding(
  state: PaperState,
  hour: number,
  rates: Record<string, { rate: Decimal; mark: Decimal }>,
): { state: PaperState; ledger: Omit<LedgerEntry, "orderId" | "at">[] } {
  if (state.fundingHour !== null && state.fundingHour >= hour) return { state, ledger: [] };
  const positions = { ...state.positions };
  const ledger: Omit<LedgerEntry, "orderId" | "at">[] = [];
  for (const [id, p] of Object.entries(state.positions)) {
    const r = rates[id];
    if (!r) continue;
    const margin = dec(p.margin);
    const pay = dmax(dec(p.size).mul(r.mark).mul(r.rate), margin.neg());
    if (pay.isZero()) continue;
    positions[id] = { ...p, margin: fx(margin.plus(pay)) };
    ledger.push({ kind: "funding", amountUsd: fx(pay), assetId: id, meta: { hour, rate: r.rate.toString(), mark: r.mark.toString() } });
  }
  return { state: { ...state, positions, fundingHour: hour }, ledger };
}

/** Position in True Markets' response shape, marked at `mark`. */
export function positionView(p: PaperPosition, asset: PaperAsset, mark: Decimal): Position {
  const size = dec(p.size);
  return {
    asset_id: p.assetId,
    symbol: asset.symbol,
    side: "short",
    size: fx(size),
    entry_price: fx(dec(p.entryPrice)),
    mark_price: fx(mark),
    liquidation_price: fx(liquidationPrice(p, asset)),
    margin_used: fx(dec(p.margin)),
    unrealized_pnl: fx(dec(p.entryPrice).minus(mark).mul(size)),
    leverage: p.leverage,
  };
}

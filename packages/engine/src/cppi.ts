import { Decimal, dec, type DecimalLike } from "@glade/shared";

export interface CppiParams {
  /** Starting equity the floor is measured from when not ratcheting. */
  base: DecimalLike;
  floorPct: DecimalLike;
  multiplier: DecimalLike;
  ratchet: boolean;
  /** Rebalance band as a fraction of equity. */
  band: DecimalLike;
  minNotionalUsd: DecimalLike;
  cooldownSec: number;
  maxTradesDay: number;
}

export const CPPI_DEFAULTS = {
  floorPct: "0.85",
  multiplier: "4",
  band: "0.05",
  cooldownSec: 600,
} as const;

export interface CppiState {
  /** Highest equity seen (ratchet); null before the first step. */
  peak: Decimal | null;
  lastTradeAt: Date | null;
  tradesToday: number;
}

export interface CppiLegInput {
  key: string;
  beta: DecimalLike;
  value: DecimalLike;
}

export interface CppiInputs {
  /** Total equity (portfolio total). */
  equity: DecimalLike;
  /** Value of the stock holdings being protected. */
  riskyValue: DecimalLike;
  /** Current total hedge notional. */
  hedgeNow: DecimalLike;
  legs: readonly CppiLegInput[];
}

export type CppiBlock = "inside_band" | "cooldown" | "trade_cap";

export interface CppiResult {
  peak: Decimal;
  floor: Decimal;
  cushion: Decimal;
  exposureTarget: Decimal;
  hedgeTarget: Decimal;
  legTargets: { key: string; hedge: Decimal }[];
  delta: Decimal;
  cushionRatio: Decimal;
  floorAtRisk: boolean;
  trade: boolean;
  blockedBy: CppiBlock[];
}

export const FLOOR_AT_RISK_CUSHION = new Decimal("0.03");

/** One CPPI decision. Pure: the caller persists `peak` and trade bookkeeping. */
export function cppiStep(
  state: CppiState,
  inputs: CppiInputs,
  params: CppiParams,
  now: Date,
): CppiResult {
  const V = dec(inputs.equity);
  const Vr = dec(inputs.riskyValue);
  const base = dec(params.base);
  const zero = new Decimal(0);

  const peak = params.ratchet ? Decimal.max(state.peak ?? base, V) : base;
  const floor = dec(params.floorPct).mul(peak);
  const cushion = Decimal.max(zero, V.minus(floor));
  const exposureTarget = Decimal.max(zero, Decimal.min(Vr, dec(params.multiplier).mul(cushion)));
  const hedgeTarget = Decimal.max(zero, Vr.minus(exposureTarget));

  const weights = inputs.legs.map((l) => dec(l.beta).mul(dec(l.value)));
  const wSum = weights.reduce((a, w) => a.plus(w), zero);
  const legTargets = inputs.legs.map((l, i) => ({
    key: l.key,
    hedge: wSum.gt(0) ? hedgeTarget.mul(weights[i]!).div(wSum) : zero,
  }));

  const delta = hedgeTarget.minus(dec(inputs.hedgeNow));
  const threshold = Decimal.max(dec(params.band).mul(V), dec(params.minNotionalUsd));
  const blockedBy: CppiBlock[] = [];
  if (delta.abs().lt(threshold)) blockedBy.push("inside_band");
  if (state.lastTradeAt && now.getTime() - state.lastTradeAt.getTime() < params.cooldownSec * 1000)
    blockedBy.push("cooldown");
  if (state.tradesToday >= params.maxTradesDay) blockedBy.push("trade_cap");

  const cushionRatio = V.gt(0) ? cushion.div(V) : zero;
  return {
    peak,
    floor,
    cushion,
    exposureTarget,
    hedgeTarget,
    legTargets,
    delta,
    cushionRatio,
    floorAtRisk: cushionRatio.lt(FLOOR_AT_RISK_CUSHION),
    trade: blockedBy.length === 0,
    blockedBy,
  };
}

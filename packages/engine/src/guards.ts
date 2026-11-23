import { Decimal, dec, type DecimalLike } from "@glade/shared";

export interface GuardLegInput {
  key: string;
  mark: DecimalLike;
  liquidationPrice: DecimalLike | null;
  /** Hourly funding rate; positive means shorts receive. */
  fundingRateHourly: DecimalLike;
}

export interface GuardInputs {
  legs: readonly GuardLegInput[];
  hedgeNow: DecimalLike;
  hedgeTarget: DecimalLike;
  riskyValue: DecimalLike;
  /** Time of the newest price used for decisions. */
  priceAt: Date;
  pauseAll: boolean;
  userRevoked: boolean;
}

export interface GuardParams {
  fundingMaxAnnual: DecimalLike;
  liqWarn: DecimalLike;
  liqReduce: DecimalLike;
  overHedge: DecimalLike;
  staleSec: number;
}

export const GUARD_DEFAULTS: GuardParams = {
  fundingMaxAnnual: "0.40",
  liqWarn: "0.15",
  liqReduce: "0.08",
  overHedge: "1.05",
  staleSec: 60,
};

export type GuardAction =
  | { kind: "pause"; reason: "kill_switch" | "revoked" | "stale_price" }
  | { kind: "warn_liquidation"; leg: string; distance: Decimal }
  | { kind: "reduce_leg"; leg: string; fraction: Decimal; distance: Decimal }
  | { kind: "warn_funding"; leg: string; annualised: Decimal }
  | { kind: "reduce_to_target"; from: Decimal; to: Decimal };

export const HOURS_PER_YEAR = 8760;
const REDUCE_FRACTION = new Decimal("0.25");

/** Distance from mark to liquidation as a fraction of mark. */
export function liquidationDistance(mark: DecimalLike, liq: DecimalLike): Decimal {
  const m = dec(mark);
  return dec(liq).minus(m).abs().div(m);
}

/** Run all guards. Pause actions come first; an empty list means all clear. */
export function evaluateGuards(
  inputs: GuardInputs,
  params: GuardParams = GUARD_DEFAULTS,
  now: Date,
): GuardAction[] {
  const actions: GuardAction[] = [];
  if (inputs.pauseAll) actions.push({ kind: "pause", reason: "kill_switch" });
  if (inputs.userRevoked) actions.push({ kind: "pause", reason: "revoked" });
  if (now.getTime() - inputs.priceAt.getTime() > params.staleSec * 1000)
    actions.push({ kind: "pause", reason: "stale_price" });

  for (const leg of inputs.legs) {
    if (leg.liquidationPrice !== null && dec(leg.mark).gt(0)) {
      const distance = liquidationDistance(leg.mark, leg.liquidationPrice);
      if (distance.lt(dec(params.liqReduce)))
        actions.push({ kind: "reduce_leg", leg: leg.key, fraction: REDUCE_FRACTION, distance });
      else if (distance.lt(dec(params.liqWarn)))
        actions.push({ kind: "warn_liquidation", leg: leg.key, distance });
    }
    const rate = dec(leg.fundingRateHourly);
    const annualised = rate.abs().mul(HOURS_PER_YEAR);
    if (rate.lt(0) && annualised.gt(dec(params.fundingMaxAnnual)))
      actions.push({ kind: "warn_funding", leg: leg.key, annualised });
  }

  const hNow = dec(inputs.hedgeNow);
  const vr = dec(inputs.riskyValue);
  if (hNow.gt(dec(params.overHedge).mul(vr))) {
    actions.push({
      kind: "reduce_to_target",
      from: hNow,
      to: Decimal.max(new Decimal(0), Decimal.min(dec(inputs.hedgeTarget), vr)),
    });
  }
  return actions;
}

import { Decimal, dec, floorToStep, type DecimalLike } from "@glade/shared";

export interface ShieldLegInput {
  economic_asset_id: string;
  perp_asset_id: string;
  /** Value of the holding group in USD. */
  value: DecimalLike;
  beta: DecimalLike;
  /** Perp mark price. */
  mark: DecimalLike;
  sizeStep: DecimalLike;
  /** Hourly funding rate; positive means shorts receive. */
  fundingRateHourly: DecimalLike;
}

export interface ShieldParams {
  /** Hedge ratio h in [0, 1]. */
  ratio: DecimalLike;
  leverage: DecimalLike;
  minNotionalUsd: DecimalLike;
  freeUsdc: DecimalLike;
}

export type ShieldRejectReason = "below_min_notional" | "insufficient_margin" | "invalid_input";

export interface ShieldLegPlan {
  economic_asset_id: string;
  perp_asset_id: string;
  /** Target hedge notional H = h·β·V. */
  targetNotional: Decimal;
  /** Base-unit quantity, rounded down to the size step. */
  qty: Decimal;
  /** qty × mark: the notional actually ordered. */
  notional: Decimal;
  /** H / L (conservative: uses the target notional). */
  margin: Decimal;
  /** Expected USD funding per day on the ordered notional; positive = income. */
  fundingPerDay: Decimal;
  rejected: ShieldRejectReason | null;
}

export interface Scenario {
  shock: Decimal;
  pnlSpot: Decimal;
  pnlHedge: Decimal;
  net: Decimal;
}

export interface ShieldPlan {
  legs: ShieldLegPlan[];
  totalValue: Decimal;
  totalNotional: Decimal;
  totalMargin: Decimal;
  /** Margin plus 10% buffer that free USDC must cover. */
  requiredUsdc: Decimal;
  fundingPerDay: Decimal;
  scenarios: Scenario[];
  ok: boolean;
  reasons: ShieldRejectReason[];
}

export const SCENARIO_SHOCKS = ["-0.2", "-0.1", "0.1"] as const;
const MARGIN_BUFFER = new Decimal("1.1");

/** Size a Shield: one short perp leg per holding group. Pure; no orders are placed. */
export function sizeShield(legs: readonly ShieldLegInput[], params: ShieldParams): ShieldPlan {
  const h = dec(params.ratio);
  const L = dec(params.leverage);
  const minNotional = dec(params.minNotionalUsd);
  const reasons = new Set<ShieldRejectReason>();
  if (h.lt(0) || h.gt(1) || L.lte(0)) reasons.add("invalid_input");

  const planned: ShieldLegPlan[] = legs.map((leg) => {
    const V = dec(leg.value);
    const beta = dec(leg.beta);
    const mark = dec(leg.mark);
    if (mark.lte(0) || V.lt(0) || beta.lte(0)) {
      reasons.add("invalid_input");
      const z = new Decimal(0);
      return {
        economic_asset_id: leg.economic_asset_id,
        perp_asset_id: leg.perp_asset_id,
        targetNotional: z,
        qty: z,
        notional: z,
        margin: z,
        fundingPerDay: z,
        rejected: "invalid_input" as const,
      };
    }
    const H = h.mul(beta).mul(V);
    const qty = floorToStep(H.div(mark), leg.sizeStep);
    const notional = qty.mul(mark);
    const margin = L.gt(0) ? H.div(L) : new Decimal(0);
    const rejected = notional.lt(minNotional) ? ("below_min_notional" as const) : null;
    if (rejected) reasons.add(rejected);
    return {
      economic_asset_id: leg.economic_asset_id,
      perp_asset_id: leg.perp_asset_id,
      targetNotional: H,
      qty,
      notional,
      margin,
      fundingPerDay: notional.mul(dec(leg.fundingRateHourly)).mul(24),
      rejected,
    };
  });

  const sum = (f: (l: ShieldLegPlan) => Decimal) =>
    planned.reduce((a, l) => a.plus(f(l)), new Decimal(0));
  const totalValue = legs.reduce((a, l) => a.plus(dec(l.value)), new Decimal(0));
  const totalMargin = sum((l) => l.margin);
  const requiredUsdc = totalMargin.mul(MARGIN_BUFFER);
  if (dec(params.freeUsdc).lt(requiredUsdc)) reasons.add("insufficient_margin");

  // A holding with beta β moves s when its hedge instrument moves s/β.
  const scenarios = SCENARIO_SHOCKS.map((s) => {
    const shock = new Decimal(s);
    const pnlSpot = shock.mul(totalValue);
    const pnlHedge = planned.reduce((a, l, i) => {
      const beta = dec(legs[i]!.beta);
      return beta.lte(0) ? a : a.minus(shock.div(beta).mul(l.notional));
    }, new Decimal(0));
    return { shock, pnlSpot, pnlHedge, net: pnlSpot.plus(pnlHedge) };
  });

  return {
    legs: planned,
    totalValue,
    totalNotional: sum((l) => l.notional),
    totalMargin,
    requiredUsdc,
    fundingPerDay: sum((l) => l.fundingPerDay),
    scenarios,
    ok: reasons.size === 0,
    reasons: [...reasons],
  };
}

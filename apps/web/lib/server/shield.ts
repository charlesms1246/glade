import "server-only";
import { currentClosure } from "@glade/calendar";
import { schema } from "@glade/db";
import { chooseInstrument, groupHoldings, sizeShield, type Holding } from "@glade/engine";
import { Decimal, dec, dmin } from "@glade/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getBellView } from "./bell";
import { db } from "./db";
import { fundingRates, knownStockBases, livePrice, perpListings } from "./market";
import { bellUnwindAt, legsOverCap, maxOrderUsd } from "./plan-rules";
import { planHeader, type PlanBase, type PlanLeg } from "./plans";
import { allocateCloses, type CloseLeg, type OpenHedge } from "./unshield-alloc";
import { allocateExisting, hedgedShare, remainingValue } from "./shield-sizing";
import { PERP_FEE_BP, venueFor } from "./venue";

export const DEFAULT_LEVERAGE = "2";
// Smallest perp order increment assumed by the paper venue; quantities round down to it.
const PERP_SIZE_STEP = "0.001";

export interface ShieldRow {
  symbol: string;
  valueUsd: string;
  perpSymbol: string;
  method: "matched" | "index";
  lowConfidence: boolean;
  beta: string;
  mark: string;
  qty: string;
  notionalUsd: string;
  /** Notional of short perps already open on this instrument that count toward the target. */
  alreadyHedgedUsd: string;
  marginUsd: string;
  liquidationEstimate: string;
  fundingPerDayUsd: string;
  feeUsd: string;
  rejected: string | null;
}

export interface ShieldPlan extends PlanBase {
  kind: "shield" | "bell";
  ratio: string;
  /** Share of hedge capacity (β × value) covered by existing shorts, and after this plan. */
  hedgedBefore: string;
  hedgedAfter: string;
  leverage: string;
  unwindAt?: string;
  /** Bell only: the opening estimates the user saw, for the held stocks. */
  estimates?: { symbol: string; close: string; impliedOpen: string; gap: string; band: string }[];
  rows: ShieldRow[];
  unhedgeable: string[];
  totals: { valueUsd: string; notionalUsd: string; marginUsd: string; requiredUsdc: string; fundingPerDayUsd: string; feesUsd: string };
  scenarios: { shock: string; spotUsd: string; hedgeUsd: string; netUsd: string }[];
  cashUsd: string;
  maxOrderUsd: string;
  ok: boolean;
  reasons: string[];
}

export interface UnshieldPlan extends PlanBase {
  kind: "unshield";
  legs: CloseLeg[];
  /** Fee per leg, in the same order as `legs`. */
  legFeesUsd: string[];
  feesUsd: string;
  maxOrderUsd: string;
}

const REASON_TEXT: Record<string, string> = {
  below_min_notional: "A leg is below the minimum perp order size, so it is left out.",
  insufficient_margin: "Your paper cash does not cover the margin plus a 10% buffer.",
  invalid_input: "Some prices were missing; try again in a moment.",
  no_holdings: "You hold no stocks yet. Buy one first.",
  no_legs: "Nothing to hedge at this ratio.",
  already_hedged: "Existing shorts already cover this ratio for a holding, so it is left out.",
  above_max_order: "A leg is above the per-order limit, so it is left out. Try a lower ratio.",
};

/** Liquidation estimate for an isolated short: entry × (1 + 1/L − mmr), with mmr = 1/(2·max leverage). */
const shortLiquidation = (mark: Decimal, lev: Decimal, maxLev: Decimal) => mark.mul(dec(1).plus(dec(1).div(lev)).minus(dec(1).div(maxLev.mul(2))));

/** Stock holdings from the paper portfolio, in engine form. */
export async function stockHoldings(userId: string, loaded?: Awaited<ReturnType<ReturnType<typeof venueFor>["portfolio"]>>) {
  const [portfolio, bases] = await Promise.all([loaded ?? venueFor(userId).portfolio(), knownStockBases()]);
  const holdings: Holding[] = portfolio.balances
    .filter((b) => !b.stable && b.value && dec(b.value).gt(0) && bases.has(b.symbol.toUpperCase()))
    .map((b) => ({ asset_id: b.asset_id ?? b.symbol, economic_asset_id: b.economic_asset_id ?? b.asset_id ?? b.symbol, symbol: b.symbol, value: b.value! }));
  return { holdings, groups: groupHoldings(holdings, bases), cash: dec(portfolio.cash_usd ?? "0") };
}

export async function buildShieldPlan(userId: string, ratio: string, kind: "shield" | "bell", now = new Date()): Promise<ShieldPlan | { error: string }> {
  let unwindAt: string | undefined;
  if (kind === "bell") {
    const closure = currentClosure(now);
    if (!closure) return { error: "The market is open; Shield until the bell is offered only while it is closed." };
    unwindAt = bellUnwindAt(closure);
  }
  const portfolio = await venueFor(userId).portfolio();
  const positions = portfolio.positions ?? [];
  const [{ groups, cash }, perps, funding] = await Promise.all([stockHoldings(userId, portfolio), perpListings(), fundingRates()]);
  const existingByPerp = new Map<string, Decimal>();
  for (const p of positions) {
    if (p.side !== "short" || !p.asset_id || !p.size || dec(p.size).lte(0)) continue;
    const notional = dec(p.size).mul(dec(p.mark_price ?? p.entry_price ?? "0"));
    existingByPerp.set(p.asset_id, (existingByPerp.get(p.asset_id) ?? dec(0)).plus(notional));
  }
  const reasons = new Set<string>();
  if (groups.length === 0) reasons.add("no_holdings");

  const unhedgeable: string[] = [];
  const picked = await Promise.all(
    groups.map(async (g) => {
      const leg = chooseInstrument(g, perps);
      const mark = leg ? await livePrice(leg.perp_symbol, "perp") : null;
      if (!leg || !mark) {
        unhedgeable.push(g.symbol);
        return null;
      }
      const maxLev = dec(perps.find((p) => p.asset_id === leg.perp_asset_id)?.max_leverage ?? 1);
      return { g, leg, mark: dec(mark), maxLev };
    }),
  );
  const usable = picked.filter((p) => p !== null);
  const maxLevAll = usable.reduce((m, p) => dmin(m, p.maxLev), dec(DEFAULT_LEVERAGE));
  const lev = dmin(dec(DEFAULT_LEVERAGE), maxLevAll);

  // Existing shorts count as already hedged: size only the gap up to the target.
  const ratioD = dec(ratio);
  const covered = allocateExisting(
    usable.map((p) => ({ perpAssetId: p.leg.perp_asset_id, value: p.g.value, beta: dec(p.leg.beta) })),
    ratioD,
    existingByPerp,
  );
  const sized = sizeShield(
    usable.map((p, i) => ({
      economic_asset_id: p.g.economic_asset_id,
      perp_asset_id: p.leg.perp_asset_id,
      value: remainingValue(p.g.value, dec(p.leg.beta), ratioD, covered[i]!),
      beta: p.leg.beta,
      mark: p.mark,
      sizeStep: PERP_SIZE_STEP,
      fundingRateHourly: funding[p.leg.perp_symbol] ?? "0",
    })),
    { ratio, leverage: lev, minNotionalUsd: process.env.MIN_PERP_NOTIONAL_USD ?? "10", freeUsdc: cash },
  );
  // Margin is re-checked below on the legs that will actually be placed.
  for (const r of sized.reasons) if (r !== "insufficient_margin") reasons.add(r);
  const cap = dec(maxOrderUsd());

  const coveredAll = (i: number) => sized.legs[i]!.targetNotional.lte(0) && covered[i]!.gt(0);
  const rows: ShieldRow[] = sized.legs.map((l, i) => {
    const p = usable[i]!;
    return {
      symbol: p.g.symbol,
      valueUsd: p.g.value.toFixed(2),
      perpSymbol: p.leg.perp_symbol,
      method: p.leg.method,
      lowConfidence: p.leg.lowConfidence,
      beta: p.leg.beta.toFixed(),
      mark: p.mark.toFixed(),
      qty: l.qty.toFixed(),
      notionalUsd: l.notional.toFixed(2),
      alreadyHedgedUsd: covered[i]!.toFixed(2),
      marginUsd: l.margin.toFixed(2),
      liquidationEstimate: shortLiquidation(p.mark, lev, p.maxLev).toFixed(2),
      fundingPerDayUsd: l.fundingPerDay.toFixed(4),
      feeUsd: l.notional.mul(PERP_FEE_BP).div(10_000).toFixed(4),
      rejected: coveredAll(i) ? "already_hedged" : (l.rejected ?? (l.notional.gt(cap) ? "above_max_order" : null)),
    };
  });
  if (rows.some((r) => r.rejected === "already_hedged")) reasons.add("already_hedged");
  // A leg with nothing left to hedge is not "below minimum".
  if (!rows.some((r) => r.rejected === "below_min_notional")) reasons.delete("below_min_notional");
  if (rows.some((r) => r.rejected === "above_max_order")) reasons.add("above_max_order");

  const openLegs: PlanLeg[] = sized.legs.flatMap((l, i) =>
    rows[i]!.rejected || l.qty.lte(0)
      ? []
      : [{ assetId: l.perp_asset_id, symbol: rows[i]!.perpSymbol, side: "sell" as const, qty: l.qty.toFixed(), qtyUnit: "base" as const, leverage: lev.toFixed(), reduceOnly: false, notionalUsd: l.notional.toFixed(2), beta: rows[i]!.beta }],
  );
  if (openLegs.length === 0 && groups.length > 0) reasons.add("no_legs");
  // Bell: the approval also covers the reduce-only unwind at the open.
  const closeLegs: PlanLeg[] =
    kind === "bell" ? openLegs.map((l) => ({ assetId: l.assetId, symbol: l.symbol, side: "buy", qty: l.qty, qtyUnit: "base", reduceOnly: true, notionalUsd: l.notionalUsd, beta: l.beta })) : [];
  const estimates =
    kind === "bell"
      ? (await getBellView(now)).cards
          .filter((c) => c.close && c.impliedOpen && c.gap && rows.some((r) => r.symbol === c.symbol))
          .map((c) => ({ symbol: c.symbol, close: c.close!, impliedOpen: c.impliedOpen!, gap: c.gap!, band: c.band }))
      : undefined;
  // Totals, margin and scenarios count only the legs that will be placed.
  const kept = sized.legs.map((l, i) => ({ l, r: rows[i]!, p: usable[i]! })).filter((x) => !x.r.rejected && x.l.qty.gt(0));
  const sum = (f: (x: (typeof kept)[number]) => Decimal) => kept.reduce((a, x) => a.plus(f(x)), dec(0));
  const fees = sum((x) => dec(x.r.feeUsd));
  const totalNotional = sum((x) => x.l.notional);
  const totalMargin = sum((x) => x.l.margin);
  const requiredUsdc = totalMargin.mul("1.1");
  if (cash.lt(requiredUsdc)) reasons.add("insufficient_margin");
  const totalValue = usable.reduce((a, p) => a.plus(p.g.value), dec(0));
  const capacity = usable.reduce((a, p) => a.plus(p.g.value.mul(p.leg.beta)), dec(0));
  const existingTotal = [...new Set(usable.map((p) => p.leg.perp_asset_id))].reduce((a, id) => a.plus(existingByPerp.get(id) ?? 0), dec(0));
  const scenarios = ["-0.2", "-0.1", "0.1"].map((sh) => {
    const shock = dec(sh);
    const spot = shock.mul(totalValue);
    const newHedge = kept.reduce((a, x) => a.minus(shock.div(x.p.leg.beta).mul(x.l.notional)), dec(0));
    const oldHedge = usable.reduce((a, p, i) => a.minus(shock.div(p.leg.beta).mul(covered[i]!)), dec(0));
    return { shock: sh, spotUsd: spot.toFixed(2), hedgeUsd: newHedge.plus(oldHedge).toFixed(2), netUsd: spot.plus(newHedge).plus(oldHedge).toFixed(2) };
  });

  return {
    ...planHeader(kind, userId, [...openLegs, ...closeLegs]),
    kind,
    ratio: dec(ratio).toFixed(),
    hedgedBefore: hedgedShare(capacity, existingTotal).toFixed(4),
    hedgedAfter: hedgedShare(capacity, existingTotal.plus(totalNotional)).toFixed(4),
    leverage: lev.toFixed(),
    ...(unwindAt ? { unwindAt, estimates } : {}),
    rows,
    unhedgeable,
    totals: {
      valueUsd: totalValue.toFixed(2),
      notionalUsd: totalNotional.toFixed(2),
      marginUsd: totalMargin.toFixed(2),
      requiredUsdc: requiredUsdc.toFixed(2),
      fundingPerDayUsd: sum((x) => x.l.fundingPerDay).toFixed(4),
      feesUsd: fees.mul(kind === "bell" ? 2 : 1).toFixed(4),
    },
    scenarios,
    cashUsd: cash.toFixed(2),
    maxOrderUsd: cap.toFixed(2),
    ok: reasons.size === 0 || (openLegs.length > 0 && [...reasons].every((r) => r === "below_min_notional" || r === "above_max_order" || r === "already_hedged")),
    reasons: [...reasons].map((r) => REASON_TEXT[r] ?? r),
  };
}

/**
 * Reduce-only buys that close the user's open Shield and Bell hedges, one per hedge leg. Floor positions are left
 * to the Floor. Hedges whose position is already gone are marked closed.
 */
export async function buildUnshieldPlan(userId: string): Promise<UnshieldPlan | { error: string }> {
  const h = schema.hedges;
  const inFlight = sql`exists (select 1 from ${schema.intents} i where i.hedge_id = ${h.id} and i.status in ('pending', 'executing'))`;
  const [positions, hedges] = await Promise.all([
    venueFor(userId).positions(),
    db()
      .select({ id: h.id, legs: h.legs })
      .from(h)
      .where(and(eq(h.userId, userId), inArray(h.mode, ["shield", "bell"]), inArray(h.status, ["planned", "active"]), sql`not ${inFlight}`))
      .orderBy(asc(h.openedAt)),
  ]);
  const shorts = new Map(
    positions
      .filter((p) => p.side === "short" && p.asset_id && p.size && dec(p.size).gt(0))
      .map((p) => [p.asset_id!, { size: p.size!, mark: p.mark_price ?? p.entry_price ?? "0", symbol: p.symbol ?? p.asset_id! }]),
  );
  const { legs, emptyHedgeIds } = allocateCloses(
    hedges.map((x) => ({ id: x.id, legs: (x.legs as OpenHedge["legs"]) ?? [] })),
    shorts,
  );
  if (emptyHedgeIds.length) {
    await db().update(h).set({ status: "closed", closedAt: new Date() }).where(and(inArray(h.id, emptyHedgeIds), sql`not ${inFlight}`));
  }
  if (legs.length === 0) return { error: "You have no open Shield or Bell hedges to close." };
  const cap = maxOrderUsd();
  if (legsOverCap(legs, cap).length) return { error: `A hedge is larger than the per-order limit (${dec(cap).toFixed(2)} USD) and cannot be closed in one order.` };
  const legFees = legs.map((l) => dec(l.notionalUsd).mul(PERP_FEE_BP).div(10_000));
  const fees = legFees.reduce((a, f) => a.plus(f), dec(0));
  return { ...planHeader("unshield", userId, legs), kind: "unshield", legs, legFeesUsd: legFees.map((f) => f.toFixed(4)), feesUsd: fees.toFixed(4), maxOrderUsd: dec(cap).toFixed(2) };
}

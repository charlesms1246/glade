import "server-only";
import { currentClosure } from "@glade/calendar";
import { schema } from "@glade/db";
import { chooseInstrument, groupHoldings, sizeShield, type Holding } from "@glade/engine";
import { Decimal, dec, dmin } from "@glade/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "./db";
import { fundingRates, knownStockBases, livePrice, perpListings } from "./market";
import { planHeader, type PlanBase, type PlanLeg } from "./plans";
import { PERP_FEE_BP, venueFor } from "./venue";

export const DEFAULT_LEVERAGE = "2";
// Smallest perp order increment assumed by the paper venue; quantities round down to it.
const PERP_SIZE_STEP = "0.001";
const BELL_UNWIND_MIN = 5;

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
  marginUsd: string;
  liquidationEstimate: string;
  fundingPerDayUsd: string;
  feeUsd: string;
  rejected: string | null;
}

export interface ShieldPlan extends PlanBase {
  kind: "shield" | "bell";
  ratio: string;
  leverage: string;
  unwindAt?: string;
  rows: ShieldRow[];
  unhedgeable: string[];
  totals: { valueUsd: string; notionalUsd: string; marginUsd: string; requiredUsdc: string; fundingPerDayUsd: string; feesUsd: string };
  scenarios: { shock: string; spotUsd: string; hedgeUsd: string; netUsd: string }[];
  cashUsd: string;
  ok: boolean;
  reasons: string[];
}

export interface UnshieldPlan extends PlanBase {
  kind: "unshield";
  hedgeId: string | null;
  feesUsd: string;
}

const REASON_TEXT: Record<string, string> = {
  below_min_notional: "A leg is below the minimum perp order size, so it is left out.",
  insufficient_margin: "Your paper cash does not cover the margin plus a 10% buffer.",
  invalid_input: "Some prices were missing; try again in a moment.",
  no_holdings: "You hold no stocks yet. Buy one first.",
  no_legs: "Nothing to hedge at this ratio.",
};

/** Liquidation estimate for an isolated short: entry × (1 + 1/L − mmr), with mmr = 1/(2·max leverage). */
const shortLiquidation = (mark: Decimal, lev: Decimal, maxLev: Decimal) => mark.mul(dec(1).plus(dec(1).div(lev)).minus(dec(1).div(maxLev.mul(2))));

/** Stock holdings from the paper portfolio, in engine form. */
export async function stockHoldings(userId: string) {
  const [portfolio, bases] = await Promise.all([venueFor(userId).portfolio(), knownStockBases()]);
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
    unwindAt = new Date(closure.openAt.getTime() + BELL_UNWIND_MIN * 60_000).toISOString();
  }
  const [{ groups, cash }, perps, funding] = await Promise.all([stockHoldings(userId), perpListings(), fundingRates()]);
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

  const sized = sizeShield(
    usable.map((p) => ({
      economic_asset_id: p.g.economic_asset_id,
      perp_asset_id: p.leg.perp_asset_id,
      value: p.g.value,
      beta: p.leg.beta,
      mark: p.mark,
      sizeStep: PERP_SIZE_STEP,
      fundingRateHourly: funding[p.leg.perp_symbol] ?? "0",
    })),
    { ratio, leverage: lev, minNotionalUsd: process.env.MIN_PERP_NOTIONAL_USD ?? "10", freeUsdc: cash },
  );
  for (const r of sized.reasons) reasons.add(r);

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
      marginUsd: l.margin.toFixed(2),
      liquidationEstimate: shortLiquidation(p.mark, lev, p.maxLev).toFixed(2),
      fundingPerDayUsd: l.fundingPerDay.toFixed(4),
      feeUsd: l.notional.mul(PERP_FEE_BP).div(10_000).toFixed(4),
      rejected: l.rejected,
    };
  });

  const openLegs: PlanLeg[] = sized.legs.flatMap((l, i) =>
    l.rejected || l.qty.lte(0)
      ? []
      : [{ assetId: l.perp_asset_id, symbol: rows[i]!.perpSymbol, side: "sell" as const, qty: l.qty.toFixed(), qtyUnit: "base" as const, leverage: lev.toFixed(), reduceOnly: false, notionalUsd: l.notional.toFixed(2), beta: rows[i]!.beta }],
  );
  if (openLegs.length === 0 && groups.length > 0) reasons.add("no_legs");
  // Bell: the approval also covers the reduce-only unwind at the open.
  const closeLegs: PlanLeg[] =
    kind === "bell" ? openLegs.map((l) => ({ assetId: l.assetId, symbol: l.symbol, side: "buy", qty: l.qty, qtyUnit: "base", reduceOnly: true, notionalUsd: l.notionalUsd, beta: l.beta })) : [];
  const fees = rows.filter((r) => !r.rejected).reduce((a, r) => a.plus(r.feeUsd), dec(0));

  return {
    ...planHeader(kind, userId, [...openLegs, ...closeLegs]),
    kind,
    ratio: dec(ratio).toFixed(),
    leverage: lev.toFixed(),
    ...(unwindAt ? { unwindAt } : {}),
    rows,
    unhedgeable,
    totals: {
      valueUsd: sized.totalValue.toFixed(2),
      notionalUsd: sized.totalNotional.toFixed(2),
      marginUsd: sized.totalMargin.toFixed(2),
      requiredUsdc: sized.requiredUsdc.toFixed(2),
      fundingPerDayUsd: sized.fundingPerDay.toFixed(4),
      feesUsd: fees.mul(kind === "bell" ? 2 : 1).toFixed(4),
    },
    scenarios: sized.scenarios.map((s) => ({ shock: s.shock.toFixed(), spotUsd: s.pnlSpot.toFixed(2), hedgeUsd: s.pnlHedge.toFixed(2), netUsd: s.net.toFixed(2) })),
    cashUsd: cash.toFixed(2),
    ok: reasons.size === 0 || (openLegs.length > 0 && [...reasons].every((r) => r === "below_min_notional")),
    reasons: [...reasons].map((r) => REASON_TEXT[r] ?? r),
  };
}

/** The user's newest shield or bell hedge that is still open. */
export async function openHedge(userId: string, modes: ("shield" | "bell")[] = ["shield", "bell"]) {
  const [h] = await db()
    .select()
    .from(schema.hedges)
    .where(and(eq(schema.hedges.userId, userId), inArray(schema.hedges.mode, modes), inArray(schema.hedges.status, ["planned", "active"])))
    .orderBy(desc(schema.hedges.openedAt))
    .limit(1);
  return h ?? null;
}

/** Reduce-only buys that close every short perp position. */
export async function buildUnshieldPlan(userId: string): Promise<UnshieldPlan | { error: string }> {
  const positions = (await venueFor(userId).positions()).filter((p) => p.side === "short" && p.asset_id && p.size && dec(p.size).gt(0));
  if (positions.length === 0) return { error: "You have no open hedges to close." };
  const legs: PlanLeg[] = positions.map((p) => {
    const notional = dec(p.size!).mul(dec(p.mark_price ?? p.entry_price ?? "0"));
    return { assetId: p.asset_id!, symbol: p.symbol ?? p.asset_id!, side: "buy", qty: dec(p.size!).toFixed(), qtyUnit: "base", reduceOnly: true, notionalUsd: notional.toFixed(2), beta: "1" };
  });
  const fees = legs.reduce((a, l) => a.plus(dec(l.notionalUsd).mul(PERP_FEE_BP).div(10_000)), dec(0));
  const hedge = await openHedge(userId);
  return { ...planHeader("unshield", userId, legs), kind: "unshield", hedgeId: hedge?.id ?? null, feesUsd: fees.toFixed(4) };
}

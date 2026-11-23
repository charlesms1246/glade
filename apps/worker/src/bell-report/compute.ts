import { bellReport, impliedOpen } from "@glade/engine";
import { Decimal, dec } from "@glade/shared";
import { z } from "zod";

/** The parts of an approved Bell plan the report needs. Unknown fields pass through. */
const planSchema = z
  .object({
    kind: z.literal("bell"),
    rows: z.array(
      z.object({ symbol: z.string(), valueUsd: z.string(), perpSymbol: z.string(), rejected: z.string().nullish() }).passthrough(),
    ),
    legs: z.array(z.object({ assetId: z.string(), symbol: z.string(), reduceOnly: z.boolean() }).passthrough()),
    // Optional estimate recorded at approval: fraction, by perp symbol or one for all.
    estGapPct: z.string().optional(),
    estimates: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

export interface Fill {
  assetId: string;
  kind: "open" | "close";
  executedQty: string;
  avgPrice: string;
  fee: string;
}

export interface Snapshot {
  symbol: string;
  closePx: string;
  basis: string;
}

export interface LegInputs {
  plan: unknown;
  fills: Fill[];
  snapshots: Snapshot[];
  /** Spot price 5 minutes after the open, by snapshot symbol. */
  openPx: Record<string, string>;
  /** Net funding received by the short while open, by perp asset id (positive = received). */
  fundingReceived: Record<string, string>;
}

export interface LegReport {
  symbol: string;
  holding: string;
  estGap: Decimal;
  estSource: "plan" | "implied_at_open_fill";
  realisedGap: Decimal;
  estGapUsd: Decimal;
  realGapUsd: Decimal;
  hedgePnl: Decimal;
  cost: Decimal;
  saved: Decimal;
  accuracyBp: Decimal;
  value: Decimal;
}

export interface HedgeReport {
  legs: LegReport[];
  estGapUsd: Decimal;
  realGapUsd: Decimal;
  savedUsd: Decimal;
  costUsd: Decimal;
  /** Value-weighted |estimate − realised| in bp. */
  accuracyBp: Decimal;
}

const sum = (xs: Decimal[]) => xs.reduce((a, x) => a.plus(x), new Decimal(0));

/**
 * Per-leg and total Bell report for one closed hedge. Pure. Returns a reason string when the
 * inputs are not complete yet (e.g. the post-open price is missing), so the caller retries later.
 */
export function computeHedgeReport(i: LegInputs): HedgeReport | string {
  const parsed = planSchema.safeParse(i.plan);
  if (!parsed.success) return "plan is not a bell plan";
  const plan = parsed.data;
  const snaps = new Map(i.snapshots.map((s) => [s.symbol, s]));
  const legs: LegReport[] = [];
  for (const row of plan.rows) {
    if (row.rejected) continue;
    const leg = plan.legs.find((l) => !l.reduceOnly && l.symbol === row.perpSymbol);
    if (!leg) continue;
    const fills = i.fills.filter((f) => f.assetId === leg.assetId);
    const opens = fills.filter((f) => f.kind === "open");
    if (opens.length === 0) continue;
    const snap = snaps.get(row.perpSymbol);
    if (!snap) return `no close snapshot for ${row.perpSymbol}`;
    const open = i.openPx[row.perpSymbol];
    if (!open) return `no post-open price for ${row.perpSymbol}`;

    const qty = sum(opens.map((f) => dec(f.executedQty)));
    // Volume-weighted open fill price: the perp mark the estimate is read from.
    const openVwap = sum(opens.map((f) => dec(f.executedQty).mul(f.avgPrice))).div(qty);
    const planned = plan.estimates?.[row.perpSymbol] ?? plan.estGapPct;
    // Without a recorded estimate: the implied gap at the open fill (mark with the close basis removed).
    const estGap = planned !== undefined ? dec(planned) : impliedOpen(openVwap, snap.basis).div(snap.closePx).minus(1);
    const fees = sum(fills.map((f) => dec(f.fee)));
    const r = bellReport({
      close: snap.closePx,
      open,
      hedgeQty: qty,
      value: row.valueUsd,
      estGap,
      fees,
      funding: dec(i.fundingReceived[leg.assetId] ?? "0").neg(),
    });
    legs.push({
      symbol: row.perpSymbol,
      holding: row.symbol,
      estGap,
      estSource: planned !== undefined ? "plan" : "implied_at_open_fill",
      realisedGap: r.realisedGap,
      estGapUsd: r.estGapUsd,
      realGapUsd: r.realGapUsd,
      hedgePnl: r.saved.plus(r.cost),
      cost: r.cost,
      saved: r.saved,
      accuracyBp: r.accuracyBp,
      value: dec(row.valueUsd),
    });
  }
  if (legs.length === 0) return "no filled legs";
  const totalValue = sum(legs.map((l) => l.value));
  return {
    legs,
    estGapUsd: sum(legs.map((l) => l.estGapUsd)),
    realGapUsd: sum(legs.map((l) => l.realGapUsd)),
    savedUsd: sum(legs.map((l) => l.saved)),
    costUsd: sum(legs.map((l) => l.cost)),
    accuracyBp: totalValue.gt(0) ? sum(legs.map((l) => l.accuracyBp.mul(l.value))).div(totalValue) : sum(legs.map((l) => l.accuracyBp)).div(legs.length),
  };
}

const pct = (d: Decimal) => `${d.gte(0) ? "+" : "−"}${d.abs().mul(100).toFixed(1)}%`;
const usd = (d: Decimal) => `${d.gte(0) ? "" : "−"}$${d.abs().toFixed(2)}`;

/** Plain-English activity line, e.g. "Bell report: NVDA opened +2.1% vs estimate +1.6% (±2.3%). …". */
export function explainReport(r: HedgeReport, band: Decimal): string {
  const moves = r.legs.map((l) => `${l.symbol} opened ${pct(l.realisedGap)} vs estimate ${pct(l.estGap)} (±${band.mul(100).toFixed(1)}%)`).join("; ");
  const pnl = sum(r.legs.map((l) => l.hedgePnl));
  return `Bell report: ${moves}. Hedge P&L ${usd(pnl)}, costs ${usd(r.costUsd)}, net saved ${usd(r.savedUsd)}.`;
}

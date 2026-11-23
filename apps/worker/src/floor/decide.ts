import {
  chooseInstrument,
  cppiStep,
  groupHoldings,
  type CppiResult,
  type CppiState,
  type PerpListing,
} from "@glade/engine";
import { dec, Decimal, floorToStep, fmtPct, fmtUsd } from "@glade/shared";

export interface FloorMandate {
  floorPct: string;
  multiplier: string;
  ratchet: boolean;
  baseUsd: string;
  leverageMax: string;
  allowedPerps: readonly string[];
  maxTradesDay: number;
}

export interface FloorInputs {
  equity: string;
  holdings: { asset_id: string; economic_asset_id: string; symbol: string; value: string }[];
  /** Open short perp positions. */
  positions: { asset_id: string; size: string; mark_price: string }[];
  perps: readonly PerpListing[];
  /** Latest perp mark by perp asset id (for legs without a position yet). */
  marks: Readonly<Record<string, string>>;
}

export interface FloorParams {
  band: string;
  cooldownSec: number;
  minNotionalUsd: string;
  leverage: string;
  sizeStep: (perpAssetId: string) => string;
}

export interface FloorDraft {
  kind: "open" | "increase" | "decrease";
  assetId: string;
  side: "sell" | "buy";
  qty: string;
  leverage: string | null;
  reduceOnly: boolean;
  notionalUsd: string;
  beta: string;
}

export interface FloorDecision {
  cppi: CppiResult;
  drafts: FloorDraft[];
  explanation: string;
  skipped: string[];
}

/** One Floor rebalance decision. Pure: the caller persists the new peak and trade bookkeeping. */
export function decideFloor(m: FloorMandate, state: CppiState, inp: FloorInputs, p: FloorParams, now: Date): FloorDecision {
  const groups = groupHoldings(inp.holdings);
  const legs = groups
    .map((g) => ({ g, leg: chooseInstrument(g, inp.perps) }))
    .filter((x): x is { g: (typeof groups)[number]; leg: NonNullable<ReturnType<typeof chooseInstrument>> } => x.leg !== null);
  const skipped = groups.filter((g) => !legs.some((l) => l.g === g)).map((g) => `${g.symbol}: no perp to hedge with`);
  const allowed = legs.filter((l) => m.allowedPerps.includes(l.leg.perp_asset_id));
  for (const l of legs) if (!allowed.includes(l)) skipped.push(`${l.g.symbol}: ${l.leg.perp_symbol} perp not allowed by the mandate`);

  const riskyValue = allowed.reduce((a, l) => a.plus(l.g.value), new Decimal(0));
  const shortBy = new Map(inp.positions.map((x) => [x.asset_id, x]));
  const markOf = (id: string) => dec(shortBy.get(id)?.mark_price ?? inp.marks[id] ?? "0");
  const hedgeNow = allowed.reduce((a, l) => a.plus(dec(shortBy.get(l.leg.perp_asset_id)?.size ?? "0").mul(markOf(l.leg.perp_asset_id))), new Decimal(0));

  const cppi = cppiStep(
    state,
    {
      equity: inp.equity,
      riskyValue,
      hedgeNow,
      legs: allowed.map((l) => ({ key: l.leg.perp_asset_id, beta: l.leg.beta, value: l.g.value })),
    },
    {
      base: m.baseUsd,
      floorPct: m.floorPct,
      multiplier: m.multiplier,
      ratchet: m.ratchet,
      band: p.band,
      minNotionalUsd: p.minNotionalUsd,
      cooldownSec: p.cooldownSec,
      maxTradesDay: m.maxTradesDay,
    },
    now,
  );

  const drafts: FloorDraft[] = [];
  if (cppi.trade) {
    for (const t of cppi.legTargets) {
      const mark = markOf(t.key);
      if (mark.lte(0)) {
        skipped.push(`${t.key}: no mark price`);
        continue;
      }
      const curSize = dec(shortBy.get(t.key)?.size ?? "0");
      const targetSize = t.hedge.div(mark);
      const diff = targetSize.minus(curSize);
      const qty = floorToStep(diff.abs(), p.sizeStep(t.key));
      if (qty.isZero() || qty.mul(mark).lt(dec(p.minNotionalUsd))) continue;
      const beta = allowed.find((l) => l.leg.perp_asset_id === t.key)!.leg.beta.toString();
      const notionalUsd = qty.mul(mark).toFixed(2, Decimal.ROUND_UP);
      const leverage = Decimal.min(dec(p.leverage), dec(m.leverageMax)).toString();
      drafts.push(
        diff.gt(0)
          ? { kind: curSize.isZero() ? "open" : "increase", assetId: t.key, side: "sell", qty: qty.toString(), leverage, reduceOnly: false, notionalUsd, beta }
          : { kind: "decrease", assetId: t.key, side: "buy", qty: Decimal.min(qty, curSize).toString(), leverage: null, reduceOnly: true, notionalUsd, beta },
      );
    }
  }

  const hedgeRatio = riskyValue.gt(0) ? cppi.hedgeTarget.div(riskyValue) : new Decimal(0);
  const explanation = drafts.length
    ? `Hedge ${cppi.delta.gt(0) ? "raised" : "lowered"} toward ${fmtPct(hedgeRatio, 0)} of stock value: equity ${fmtUsd(inp.equity)}, target floor ${fmtUsd(cppi.floor)}, cushion ${fmtPct(cppi.cushionRatio, 1)}.`
    : `No change: ${cppi.blockedBy.length ? cppi.blockedBy.join(", ").replaceAll("_", " ") : "hedge already on target"} (cushion ${fmtPct(cppi.cushionRatio, 1)}, target floor ${fmtUsd(cppi.floor)}).`;
  return { cppi, drafts, explanation, skipped };
}

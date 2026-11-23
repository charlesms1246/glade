import { dec, Decimal } from "@glade/shared";

interface HedgeLegLike {
  assetId: string;
  symbol: string;
  side: string;
  qty: string;
  reduceOnly: boolean;
  beta?: string;
}

export interface OpenHedge {
  id: string;
  legs: readonly HedgeLegLike[];
}

export interface ShortPosition {
  size: string;
  mark: string;
  symbol: string;
}

export interface CloseLeg {
  hedgeId: string;
  assetId: string;
  symbol: string;
  side: "buy";
  qty: string;
  qtyUnit: "base";
  reduceOnly: true;
  notionalUsd: string;
  beta: string;
}

/**
 * One reduce-only close per open leg of each Shield/Bell hedge, sized by what the hedge opened and capped by the
 * short still open on that perp (oldest hedge first). Shorts beyond the hedges' legs belong to the Floor and stay.
 * Hedges with nothing left to close are returned separately.
 */
export function allocateCloses(hedges: readonly OpenHedge[], shorts: ReadonlyMap<string, ShortPosition>) {
  const left = new Map([...shorts].map(([id, p]) => [id, dec(p.size)]));
  const legs: CloseLeg[] = [];
  const emptyHedgeIds: string[] = [];
  for (const h of hedges) {
    let any = false;
    for (const l of h.legs) {
      if (l.reduceOnly || l.side !== "sell") continue;
      const pos = shorts.get(l.assetId);
      const qty = Decimal.min(dec(l.qty), left.get(l.assetId) ?? dec(0));
      if (!pos || qty.lte(0)) continue;
      left.set(l.assetId, left.get(l.assetId)!.minus(qty));
      any = true;
      legs.push({
        hedgeId: h.id,
        assetId: l.assetId,
        symbol: pos.symbol,
        side: "buy",
        qty: qty.toString(),
        qtyUnit: "base",
        reduceOnly: true,
        notionalUsd: qty.mul(dec(pos.mark)).toFixed(2),
        beta: l.beta ?? "1",
      });
    }
    if (!any) emptyHedgeIds.push(h.id);
  }
  return { legs, emptyHedgeIds };
}

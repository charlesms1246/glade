import { INDEX_PERPS, normalizeSymbol } from "@glade/engine";
import { dec, Decimal } from "@glade/shared";

export interface ExposureInput {
  perpAssetId: string;
  perps: readonly { asset_id: string; symbol: string }[];
  /** Non-stable holdings with their USD value. */
  holdings: readonly { symbol: string; value: string }[];
  positions: readonly { side?: string | null; asset_id?: string | null; size?: string | null; mark_price?: string | null }[];
}

/**
 * What a new short on this perp is capped against: the value of the holdings it hedges (its symbol group;
 * the whole stock book for an index perp) and the short already open on it, whichever hedge opened it.
 */
export function groupExposure(x: ExposureInput): { holdingValue: string; existingShortUsd: string } {
  const perp = x.perps.find((p) => p.asset_id === x.perpAssetId);
  const bases = new Set(x.perps.map((p) => p.symbol.toUpperCase()));
  const sym = perp?.symbol.toUpperCase() ?? "";
  const isIndex = (INDEX_PERPS as readonly string[]).includes(sym);
  const holdingValue = x.holdings
    .filter((h) => isIndex || normalizeSymbol(h.symbol, bases) === sym)
    .reduce((a, h) => a.plus(dec(h.value)), new Decimal(0));
  const existing = x.positions
    .filter((p) => p.side === "short" && p.asset_id === x.perpAssetId && p.size && p.mark_price)
    .reduce((a, p) => a.plus(dec(p.size!).mul(dec(p.mark_price!))), new Decimal(0));
  return { holdingValue: holdingValue.toString(), existingShortUsd: existing.toString() };
}

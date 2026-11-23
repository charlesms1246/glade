import { Decimal, dec, type DecimalLike } from "@glade/shared";

/** A perp listing from the asset registry. Ids come from the registry, never hard-coded. */
export interface PerpListing {
  asset_id: string;
  symbol: string;
  max_leverage?: DecimalLike;
}

export interface Holding {
  asset_id: string;
  economic_asset_id: string;
  symbol: string;
  value: DecimalLike;
}

export interface HoldingGroup {
  economic_asset_id: string;
  symbol: string;
  value: Decimal;
  asset_ids: string[];
}

export type HedgeMethod = "matched" | "index";

export interface HedgeLeg {
  economic_asset_id: string;
  symbol: string;
  perp_asset_id: string;
  perp_symbol: string;
  beta: Decimal;
  r2: Decimal;
  method: HedgeMethod;
  lowConfidence: boolean;
}

export const INDEX_PERPS = ["SP500", "XYZ100"] as const;
export type IndexPerp = (typeof INDEX_PERPS)[number];

/** Explicit issuer aliases. Anything not listed falls back to the suffix rule. */
export const SYMBOL_ALIASES: Readonly<Record<string, string>> = {
  AAPLC: "AAPL",
  AAPLX: "AAPL",
  NVDAC: "NVDA",
  NVDAX: "NVDA",
  TSLAC: "TSLA",
  TSLAX: "TSLA",
  SPCXC: "SPCX",
};

/**
 * Normalise an issuer-specific ticker to its underlying symbol.
 * A trailing "C" or "x" is stripped only when the remaining base is a known symbol,
 * so real tickers that happen to end in C or X (e.g. "CRWC" with no "CRW") stay intact.
 */
export function normalizeSymbol(symbol: string, knownBases: ReadonlySet<string> = new Set()): string {
  const upper = symbol.toUpperCase();
  const alias = SYMBOL_ALIASES[upper];
  if (alias) return alias;
  if (knownBases.has(upper)) return upper;
  if (/[CX]$/.test(upper) && upper.length > 1) {
    const base = upper.slice(0, -1);
    if (knownBases.has(base)) return base;
  }
  return upper;
}

/** Group holdings by economic asset, naming each group by its normalised symbol. */
export function groupHoldings(
  holdings: readonly Holding[],
  knownBases: ReadonlySet<string> = new Set(),
): HoldingGroup[] {
  const groups = new Map<string, HoldingGroup>();
  for (const h of holdings) {
    const g = groups.get(h.economic_asset_id);
    if (g) {
      g.value = g.value.plus(dec(h.value));
      g.asset_ids.push(h.asset_id);
    } else {
      groups.set(h.economic_asset_id, {
        economic_asset_id: h.economic_asset_id,
        symbol: normalizeSymbol(h.symbol, knownBases),
        value: dec(h.value),
        asset_ids: [h.asset_id],
      });
    }
  }
  return [...groups.values()];
}

/** Regression stats of a holding against one index perp, precomputed from history. */
export interface IndexStats {
  beta: DecimalLike;
  r2: DecimalLike;
  /** Correlation of the holding's returns with this index. */
  corr: DecimalLike;
  lowConfidence?: boolean;
}

/**
 * Pick the hedge instrument for a group: a matching single-stock perp if one exists
 * (beta 1), else an index perp (SP500 by default, XYZ100 when its correlation is higher).
 * Returns null when no usable perp is listed.
 */
export function chooseInstrument(
  group: Pick<HoldingGroup, "economic_asset_id" | "symbol">,
  perps: readonly PerpListing[],
  indexStats: Partial<Record<IndexPerp, IndexStats>> = {},
): HedgeLeg | null {
  const bySymbol = new Map(perps.map((p) => [p.symbol.toUpperCase(), p]));
  const matched = bySymbol.get(group.symbol.toUpperCase());
  if (matched && !(INDEX_PERPS as readonly string[]).includes(matched.symbol.toUpperCase())) {
    return {
      economic_asset_id: group.economic_asset_id,
      symbol: group.symbol,
      perp_asset_id: matched.asset_id,
      perp_symbol: matched.symbol,
      beta: new Decimal(1),
      r2: new Decimal(1),
      method: "matched",
      lowConfidence: false,
    };
  }

  const sp = indexStats.SP500;
  const xyz = indexStats.XYZ100;
  let pick: IndexPerp = "SP500";
  if (xyz && bySymbol.has("XYZ100") && (!sp || dec(xyz.corr).gt(dec(sp.corr)))) pick = "XYZ100";
  if (!bySymbol.has(pick)) pick = pick === "SP500" ? "XYZ100" : "SP500";
  const perp = bySymbol.get(pick);
  if (!perp) return null;

  const stats = indexStats[pick];
  return {
    economic_asset_id: group.economic_asset_id,
    symbol: group.symbol,
    perp_asset_id: perp.asset_id,
    perp_symbol: perp.symbol,
    beta: stats ? dec(stats.beta) : new Decimal(1),
    r2: stats ? dec(stats.r2) : new Decimal(0),
    method: "index",
    lowConfidence: stats ? Boolean(stats.lowConfidence) : true,
  };
}

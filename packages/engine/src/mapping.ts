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
  /** First issuer's economic asset id. Each issuer (Robinhood, Coinbase, xStocks, Ondo) has its own. */
  economic_asset_id: string;
  economic_asset_ids: string[];
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
  AAPLON: "AAPL",
  NVDAC: "NVDA",
  NVDAX: "NVDA",
  NVDAON: "NVDA",
  TSLAC: "TSLA",
  TSLAX: "TSLA",
  TSLAON: "TSLA",
  SPCXC: "SPCX",
  SPCXX: "SPCX",
  SPCXON: "SPCX",
};

/**
 * Normalise an issuer-specific ticker to its underlying symbol.
 * A trailing issuer suffix ("C", "X", "ON") is stripped only when the remaining base is a known symbol,
 * so real tickers that happen to end in C or X (e.g. "CRWC" with no "CRW") stay intact.
 */
export function normalizeSymbol(symbol: string, knownBases: ReadonlySet<string> = new Set()): string {
  const upper = symbol.toUpperCase();
  const alias = SYMBOL_ALIASES[upper];
  if (alias) return alias;
  if (knownBases.has(upper)) return upper;
  for (const suffix of ["ON", "C", "X"]) {
    if (upper.length > suffix.length && upper.endsWith(suffix)) {
      const base = upper.slice(0, -suffix.length);
      if (knownBases.has(base)) return base;
    }
  }
  return upper;
}

/** Group holdings by normalised symbol, so every issuer's token of one stock is hedged together. */
export function groupHoldings(
  holdings: readonly Holding[],
  knownBases: ReadonlySet<string> = new Set(),
): HoldingGroup[] {
  const groups = new Map<string, HoldingGroup>();
  for (const h of holdings) {
    const symbol = normalizeSymbol(h.symbol, knownBases);
    const g = groups.get(symbol);
    if (g) {
      g.value = g.value.plus(dec(h.value));
      g.asset_ids.push(h.asset_id);
      if (!g.economic_asset_ids.includes(h.economic_asset_id)) g.economic_asset_ids.push(h.economic_asset_id);
    } else {
      groups.set(symbol, {
        economic_asset_id: h.economic_asset_id,
        economic_asset_ids: [h.economic_asset_id],
        symbol,
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

/**
 * The spot symbol that represents a stock in market data: the plain ticker if listed,
 * else the Coinbase ("C"), xStocks ("X") or Ondo ("ON") token. Matching ignores case.
 */
export function referenceSpotSymbol(base: string, spotSymbols: readonly string[]): string | null {
  const byUpper = new Map(spotSymbols.map((s) => [s.toUpperCase(), s]));
  const b = base.toUpperCase();
  for (const c of [b, `${b}C`, `${b}X`, `${b}ON`]) {
    const hit = byUpper.get(c);
    if (hit) return hit;
  }
  return null;
}

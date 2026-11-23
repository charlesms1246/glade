import "server-only";
import { schema } from "@glade/db";
import type { PerpListing } from "@glade/engine";
import { and, eq, ilike, or } from "drizzle-orm";
import { cacheLife } from "next/cache";
import { db, tmEnv } from "./db";
import { tmPublic } from "./tm";

export interface StockListing {
  symbol: string;
  name: string | null;
  assetId: string;
  economicAssetId: string | null;
  venue: string | null;
  chain: string | null;
}

type Row = typeof schema.assetRegistry.$inferSelect;

// Gateway users trade on-chain listings; Solana first, where paper funds are modelled.
const rank = (r: Row) => (r.venue === "defi" ? (r.chain === "solana" ? 0 : 1) : 2);

function bestPerSymbol(rows: Row[]): StockListing[] {
  const best = new Map<string, Row>();
  for (const r of rows) {
    const cur = best.get(r.symbol);
    if (!cur || rank(r) < rank(cur)) best.set(r.symbol, r);
  }
  return [...best.values()].map((r) => ({
    symbol: r.symbol,
    name: r.name,
    assetId: r.assetId,
    economicAssetId: r.economicAssetId,
    venue: r.venue,
    chain: r.chain,
  }));
}

const stockSpot = () =>
  and(eq(schema.assetRegistry.env, tmEnv()), eq(schema.assetRegistry.type, "spot"), eq(schema.assetRegistry.assetClass, "stock"));

/** Tokenized stocks whose symbol starts with, or name contains, `q`. */
export async function searchStocks(q: string): Promise<StockListing[]> {
  const term = q.trim().replace(/[%_\\]/g, "");
  if (!term) return [];
  const rows = await db()
    .select()
    .from(schema.assetRegistry)
    .where(and(stockSpot(), or(ilike(schema.assetRegistry.symbol, `${term}%`), ilike(schema.assetRegistry.name, `%${term}%`))))
    .limit(120);
  const exact = term.toUpperCase();
  return bestPerSymbol(rows)
    .sort((a, b) => Number(b.symbol.toUpperCase() === exact) - Number(a.symbol.toUpperCase() === exact) || a.symbol.length - b.symbol.length)
    .slice(0, 20);
}

export async function stockBySymbol(symbol: string): Promise<StockListing | null> {
  const rows = await db().select().from(schema.assetRegistry).where(and(stockSpot(), eq(schema.assetRegistry.symbol, symbol)));
  return bestPerSymbol(rows)[0] ?? null;
}

/** Upper-cased spot stock symbols, used to normalise issuer tokens (NVDAX → NVDA). */
export async function knownStockBases(): Promise<Set<string>> {
  "use cache";
  cacheLife("hours");
  const rows = await db().select({ symbol: schema.assetRegistry.symbol }).from(schema.assetRegistry).where(stockSpot());
  return new Set(rows.map((r) => r.symbol.toUpperCase()));
}

export async function perpListings(): Promise<PerpListing[]> {
  "use cache";
  cacheLife("hours");
  const rows = await db()
    .select()
    .from(schema.assetRegistry)
    .where(and(eq(schema.assetRegistry.env, tmEnv()), eq(schema.assetRegistry.type, "perp")));
  return rows.map((r) => ({ asset_id: r.assetId, symbol: r.symbol, max_leverage: r.maxLeverage ?? undefined }));
}

/** Last traded price (spot) or mark (perp), as a decimal string. */
export async function livePrice(symbol: string, assetClass: "spot" | "perp"): Promise<string | null> {
  const r = await tmPublic().prices(symbol, assetClass);
  return r.candles?.find((c) => c.interval === "1h")?.closePrice ?? r.candles?.[0]?.closePrice ?? null;
}

/** Hourly funding rate per perp symbol (positive means shorts receive). */
export async function fundingRates(): Promise<Record<string, string>> {
  "use cache";
  cacheLife("minutes");
  const perps = await tmPublic().listAssets({ product_type: "perp" });
  return Object.fromEntries(perps.filter((p) => p.symbol && p.perp?.funding_rate).map((p) => [p.symbol!, p.perp!.funding_rate!]));
}

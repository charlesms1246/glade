import "server-only";
import { schema } from "@glade/db";
import { Decimal, dec, dmin } from "@glade/shared";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "./db";
import { stockHoldings } from "./shield";
import { venueFor } from "./venue";

export interface HoldingCard {
  symbol: string;
  valueUsd: string;
  tokens: { symbol: string; qty: string; priceUsd: string | null; valueUsd: string }[];
}

export interface HedgePosition {
  assetId: string;
  symbol: string;
  size: string;
  entryPrice: string | null;
  markPrice: string | null;
  liquidationPrice: string | null;
  marginUsd: string | null;
  unrealizedPnlUsd: string | null;
  notionalUsd: string;
  leverage: number | null;
  mode: "shield" | "floor" | "bell";
}

export interface PortfolioView {
  cashUsd: string;
  equityUsd: string;
  stockValueUsd: string;
  holdings: HoldingCard[];
  positions: HedgePosition[];
  exposure: { exposed: string; shielded: string; floored: string };
}

const s2 = (d: Decimal) => d.toFixed(2);

/** Paper portfolio, holdings grouped by stock, hedges labelled by mode, and the exposure split. */
export async function portfolioView(userId: string): Promise<PortfolioView> {
  const venue = venueFor(userId);
  const [portfolio, positions, { groups }, hedges] = await Promise.all([
    venue.portfolio(),
    venue.positions(),
    stockHoldings(userId),
    db()
      .select({ mode: schema.hedges.mode, legs: schema.hedges.legs })
      .from(schema.hedges)
      .where(and(eq(schema.hedges.userId, userId), inArray(schema.hedges.status, ["planned", "active", "unwinding"]))),
  ]);

  const modeByAsset = new Map<string, "shield" | "floor" | "bell">();
  for (const h of hedges) {
    for (const l of (h.legs as { assetId?: string; perp_asset_id?: string }[]) ?? []) {
      const id = l.assetId ?? l.perp_asset_id;
      if (id) modeByAsset.set(id, h.mode);
    }
  }

  const bySymbol = new Map(portfolio.balances.map((b) => [b.asset_id ?? b.symbol, b]));
  const holdings: HoldingCard[] = groups.map((g) => ({
    symbol: g.symbol,
    valueUsd: s2(g.value),
    tokens: g.asset_ids.map((id) => {
      const b = bySymbol.get(id)!;
      return { symbol: b.symbol, qty: b.total, priceUsd: b.price ?? null, valueUsd: s2(dec(b.value ?? "0")) };
    }),
  }));

  const hedgePositions: HedgePosition[] = positions
    .filter((p) => p.side === "short" && p.size && dec(p.size).gt(0))
    .map((p) => ({
      assetId: p.asset_id ?? "",
      symbol: p.symbol ?? p.asset_id ?? "",
      size: p.size!,
      entryPrice: p.entry_price ?? null,
      markPrice: p.mark_price ?? null,
      liquidationPrice: p.liquidation_price ?? null,
      marginUsd: p.margin_used ?? null,
      unrealizedPnlUsd: p.unrealized_pnl ?? null,
      notionalUsd: s2(dec(p.size!).mul(dec(p.mark_price ?? p.entry_price ?? "0"))),
      leverage: p.leverage ?? null,
      mode: modeByAsset.get(p.asset_id ?? "") ?? "shield",
    }));

  const stockValue = groups.reduce((a, g) => a.plus(g.value), dec(0));
  const sumMode = (m: (x: HedgePosition) => boolean) => hedgePositions.filter(m).reduce((a, p) => a.plus(p.notionalUsd), dec(0));
  const share = (v: Decimal) => (stockValue.gt(0) ? dmin(dec(1), v.div(stockValue)) : dec(0));
  const floored = share(sumMode((p) => p.mode === "floor"));
  const shielded = dmin(dec(1).minus(floored), share(sumMode((p) => p.mode !== "floor")));
  const exposed = stockValue.gt(0) ? dec(1).minus(floored).minus(shielded) : dec(0);

  return {
    cashUsd: s2(dec(portfolio.cash_usd ?? "0")),
    equityUsd: s2(dec(portfolio.total_usd ?? "0")),
    stockValueUsd: s2(stockValue),
    holdings,
    positions: hedgePositions,
    exposure: { exposed: exposed.toFixed(4), shielded: shielded.toFixed(4), floored: floored.toFixed(4) },
  };
}

import "server-only";
import { dec } from "@glade/shared";
import { livePrice, stockBySymbol } from "./market";
import { maxOrderUsd } from "./plan-rules";
import { planHeader, type PlanBase } from "./plans";
import { SPOT_FEE_BP, venueFor } from "./venue";

export interface BuyPlan extends PlanBase {
  kind: "spot_buy";
  symbol: string;
  name: string | null;
  usd: string;
  price: string;
  feeUsd: string;
  feeBp: string;
  estQty: string;
  cashUsd: string;
  maxOrderUsd: string;
}

export async function buildBuyPlan(userId: string, symbol: string, usd: string): Promise<{ plan: BuyPlan } | { error: string }> {
  const listing = await stockBySymbol(symbol);
  if (!listing) return { error: `${symbol} is not in the catalog.` };
  const [price, portfolio] = await Promise.all([livePrice(listing.symbol, "spot"), venueFor(userId).portfolio()]);
  if (!price || dec(price).lte(0)) return { error: `No live price for ${listing.symbol} right now.` };
  const amount = dec(usd);
  const cash = dec(portfolio.cash_usd ?? "0");
  const cap = maxOrderUsd();
  if (amount.gt(cap)) return { error: `The per-order limit is ${dec(cap).toFixed(2)} USD.` };
  if (amount.gt(cash)) return { error: `That is more than your paper cash (${cash.toFixed(2)} USD).` };
  const fee = amount.mul(SPOT_FEE_BP).div(10_000);
  const estQty = amount.minus(fee).div(price);
  const legs = [
    {
      assetId: listing.assetId,
      symbol: listing.symbol,
      side: "buy" as const,
      qty: amount.toFixed(2),
      qtyUnit: "quote" as const,
      reduceOnly: false,
      notionalUsd: amount.toFixed(2),
      beta: "1",
    },
  ];
  return {
    plan: {
      ...planHeader("spot_buy", userId, legs),
      kind: "spot_buy",
      symbol: listing.symbol,
      name: listing.name,
      usd: amount.toFixed(2),
      price: dec(price).toFixed(),
      feeUsd: fee.toFixed(4),
      feeBp: SPOT_FEE_BP,
      estQty: estQty.toFixed(8),
      cashUsd: cash.toFixed(2),
      maxOrderUsd: dec(cap).toFixed(2),
    },
  };
}

import "server-only";
import { createPaperVenue, drizzlePaperRepo, drizzleRegistry, PERP_FEE_BP as PAPER_PERP_FEE_BP, SPOT_FEE_BP as PAPER_SPOT_FEE_BP } from "@glade/paper";
import { dec, type Decimal } from "@glade/shared";
import { db, tmEnv } from "./db";
import { livePrice } from "./market";

/** Paper venue fees (basis points of notional). */
export const SPOT_FEE_BP = PAPER_SPOT_FEE_BP.toFixed();
export const PERP_FEE_BP = PAPER_PERP_FEE_BP.toFixed();

const PRICE_TTL_MS = 5_000;
// The in-flight request is cached too, so concurrent callers share one fetch.
const priceCache = new Map<string, { px: Promise<Decimal>; at: number }>();

function prices(symbol: string, cls: "spot" | "perp"): Promise<Decimal> {
  const key = `${cls}:${symbol}`;
  const hit = priceCache.get(key);
  if (hit && Date.now() - hit.at < PRICE_TTL_MS) return hit.px;
  const px = livePrice(symbol, cls).then((v) => {
    if (!v) throw new Error(`no ${cls} price for ${symbol}`);
    return dec(v);
  });
  priceCache.set(key, { px, at: Date.now() });
  px.catch(() => priceCache.delete(key));
  return px;
}

let venue: ReturnType<typeof createPaperVenue> | null = null;

/** The user's paper account (read-only here: the web never places orders), in True Markets' Portfolio/Position shapes. */
export function venueFor(appUserId: string) {
  venue ??= createPaperVenue({ repo: drizzlePaperRepo(db()), prices, registry: drizzleRegistry(db(), tmEnv()) });
  const u = venue.forUser(appUserId);
  return { portfolio: () => u.portfolio(), positions: async () => (await u.positions()).positions };
}

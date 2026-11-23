import "server-only";
import type { Portfolio, Position } from "@glade/tm-client";

/** Paper venue fees, matching the simulator (basis points of notional). */
export const SPOT_FEE_BP = "10";
export const PERP_FEE_BP = "4.5";

export interface Venue {
  portfolio(): Promise<Portfolio>;
  positions(): Promise<Position[]>;
}

const empty: Portfolio = { total_usd: "0", cash_usd: "0", balances: [], positions: [] };

/**
 * The user's paper account, in True Markets' Portfolio/Position shapes.
 * Swap point: `createPaperVenue(...).forUser(appUserId)` once @glade/paper exports it.
 */
export function venueFor(appUserId: string): Venue {
  void appUserId;
  return {
    portfolio: async () => empty,
    positions: async () => [],
  };
}

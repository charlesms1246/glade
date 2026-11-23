import { dec } from "@glade/shared";
import type { ExecIntent, ExecutorConfig, ExecVenue } from "./types";

/**
 * Hard guard, independent of the mandate: never a production order (no real money), and always under
 * MAX_ORDER_USD. With TM_ENV=prod only the simulated paper venue may run; it sends nothing to True Markets.
 */
export function prodGuard(intent: ExecIntent, cfg: ExecutorConfig, venue: ExecVenue): string[] {
  const isPaper = venue.kind === "paper";
  if (cfg.venue === "paper" && !isPaper) return ["config says paper but the venue is not the paper venue"];
  if (cfg.venue !== "paper" && isPaper) return ["the paper venue requires config venue=paper"];
  if (cfg.tmEnv === "prod" && !isPaper) return ["production orders are never placed (no real money)"];
  const reasons: string[] = [];
  const notional = dec(intent.notionalUsd);
  if (!notional.isFinite() || notional.lte(0)) reasons.push("notional must be positive");
  else if (notional.gt(dec(cfg.maxOrderUsd))) reasons.push(`notional ${notional} above MAX_ORDER_USD ${cfg.maxOrderUsd}`);
  return reasons;
}

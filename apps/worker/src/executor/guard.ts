import { dec } from "@glade/shared";
import type { ExecIntent, ExecutorConfig } from "./types";

/** Hard guard, independent of the mandate: never production (no real money), and always under MAX_ORDER_USD. */
export function prodGuard(intent: ExecIntent, cfg: ExecutorConfig): string[] {
  if (cfg.tmEnv === "prod") return ["production orders are never placed (no real money)"];
  const reasons: string[] = [];
  const notional = dec(intent.notionalUsd);
  if (!notional.isFinite() || notional.lte(0)) reasons.push("notional must be positive");
  else if (notional.gt(dec(cfg.maxOrderUsd))) reasons.push(`notional ${notional} above MAX_ORDER_USD ${cfg.maxOrderUsd}`);
  return reasons;
}

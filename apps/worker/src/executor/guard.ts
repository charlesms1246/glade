import { dec } from "@glade/shared";
import type { ExecIntent, ExecutorConfig } from "./types";

/** Hard production guard. Independent of the mandate: no prod order without ALLOW_PROD and under MAX_ORDER_USD. */
export function prodGuard(intent: ExecIntent, cfg: ExecutorConfig): string[] {
  if (cfg.tmEnv !== "prod") return [];
  const reasons: string[] = [];
  if (!cfg.allowProd) reasons.push("production orders disabled (ALLOW_PROD != 1)");
  const notional = dec(intent.notionalUsd);
  if (!notional.isFinite() || notional.lte(0)) reasons.push("notional must be positive");
  else if (notional.gt(dec(cfg.maxOrderUsd))) reasons.push(`notional ${notional} above MAX_ORDER_USD ${cfg.maxOrderUsd}`);
  return reasons;
}

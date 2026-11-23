import { existsSync, readFileSync } from "node:fs";
import type { ClosureKind } from "@glade/calendar";
import { SEED_SIGMA } from "@glade/engine";
import { dec, type Decimal } from "@glade/shared";

/** Symbols Bell tracks before any user holds them. Held symbols are added at runtime. */
export const BELL_WATCHLIST = ["NVDA", "TSLA", "AAPL", "SPCX"];
export const TICK_MS = 15_000;

/** σ by closure kind from the calibration output, else the seed. Holidays reuse the weekend value. */
export function loadBellSigma(path: string): Record<ClosureKind, Decimal> {
  const fallback = { overnight: SEED_SIGMA, weekend: SEED_SIGMA, holiday: SEED_SIGMA };
  if (!existsSync(path)) return fallback;
  const j = JSON.parse(readFileSync(path, "utf8")) as {
    summary?: { sigmaBp?: string; byKind?: Record<string, { rmsErrorBp: string | null }> };
  };
  const bp = (v: string | null | undefined) => (v ? dec(v).div(10_000) : undefined);
  const all = bp(j.summary?.sigmaBp) ?? SEED_SIGMA;
  const overnight = bp(j.summary?.byKind?.overnight?.rmsErrorBp) ?? all;
  const weekend = bp(j.summary?.byKind?.weekend?.rmsErrorBp) ?? all;
  const holiday = bp(j.summary?.byKind?.holiday?.rmsErrorBp) ?? weekend;
  return { overnight, weekend, holiday };
}

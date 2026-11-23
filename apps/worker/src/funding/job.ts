import type { AssetItem } from "@glade/tm-client";

export interface FundingJobDeps {
  /** Paper users holding perp positions. */
  users: () => Promise<string[]>;
  /** Hourly funding rate by perp symbol (positive means shorts receive). */
  hourlyRates: () => Promise<Record<string, string>>;
  /** Settle one hour for a user; idempotent per hour. Returns the ledger rows written. */
  accrue: (userId: string, rates: Record<string, string>, at: number) => Promise<unknown[]>;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

/** perp.funding_rate from /gateway/assets (hourly), keyed by symbol. Assets without a rate are skipped. */
export function ratesFromAssets(assets: AssetItem[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of assets) {
    const r = a.perp?.funding_rate;
    if (a.type === "perp" && a.symbol && r !== null && r !== undefined) out[a.symbol] = r;
  }
  return out;
}

/** Settle this hour's paper funding for every user with a short. Safe to run more than once an hour. */
export async function runFundingJob(deps: FundingJobDeps, now: Date): Promise<{ credited: string[]; unchanged: string[] }> {
  const credited: string[] = [];
  const unchanged: string[] = [];
  const users = await deps.users();
  if (users.length === 0) return { credited, unchanged };
  const rates = await deps.hourlyRates();
  if (Object.keys(rates).length === 0) {
    deps.log?.("funding_no_rates", {});
    return { credited, unchanged: users };
  }
  for (const userId of users) {
    try {
      const rows = await deps.accrue(userId, rates, now.getTime());
      (rows.length ? credited : unchanged).push(userId);
    } catch (e) {
      deps.log?.("funding_user_failed", { userId, error: String(e).slice(0, 300) });
    }
  }
  return { credited, unchanged };
}

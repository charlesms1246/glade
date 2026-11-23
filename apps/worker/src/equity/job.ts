import { dec, Decimal } from "@glade/shared";
import type { Portfolio } from "@glade/tm-client";

export const SNAPSHOT_EVERY_MS = 15 * 60_000;

/** The active mandate's floor terms plus the Floor loop's stored ratchet peak. */
export interface FloorTerms {
  floorPct: string;
  ratchet: boolean;
  baseUsd: string;
  /** floor_state.peak_usd, or null before the Floor loop first ran. */
  peakUsd: string | null;
}

export interface EquitySnapshot {
  userId: string;
  at: Date;
  equityUsd: string;
  stockUsd: string;
  hedgeNotionalUsd: string;
  floorUsd: string | null;
}

export interface EquityJobDeps {
  users: () => Promise<string[]>;
  portfolio: (userId: string) => Promise<Portfolio>;
  /** Null when the user has no active mandate. */
  floorTerms: (userId: string) => Promise<FloorTerms | null>;
  /** Insert; a snapshot already stored for (user, at) is left as is. */
  save: (s: EquitySnapshot) => Promise<void>;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

/** Start of the 15-minute bucket containing `now`, so re-runs within a bucket are idempotent. */
export const bucketStart = (now: Date) => new Date(Math.floor(now.getTime() / SNAPSHOT_EVERY_MS) * SNAPSHOT_EVERY_MS);

/** The Floor target as the Floor loop computes it: floorPct × (ratchet ? max(peak ?? base, equity) : base). */
export function floorValue(t: FloorTerms, equity: Decimal): Decimal {
  const base = dec(t.baseUsd);
  const peak = t.ratchet ? Decimal.max(t.peakUsd !== null ? dec(t.peakUsd) : base, equity) : base;
  return dec(t.floorPct).mul(peak);
}

/** Totals for one snapshot from a paper portfolio. Stock value excludes stablecoins; hedge notional is Σ size × mark. */
export function snapshotOf(userId: string, at: Date, p: Portfolio, terms: FloorTerms | null): EquitySnapshot {
  const equity = dec(p.total_usd ?? "0");
  const stock = p.balances.filter((b) => !b.stable).reduce((a, b) => a.plus(dec(b.value ?? "0")), new Decimal(0));
  const hedge = p.positions.reduce((a, x) => a.plus(dec(x.size ?? "0").mul(dec(x.mark_price ?? "0"))), new Decimal(0));
  return {
    userId,
    at,
    equityUsd: equity.toFixed(),
    stockUsd: stock.toFixed(),
    hedgeNotionalUsd: hedge.toFixed(),
    floorUsd: terms ? floorValue(terms, equity).toFixed() : null,
  };
}

/** Store one equity snapshot per paper user for the current 15-minute bucket. Safe to run more often. */
export async function runEquityJob(deps: EquityJobDeps, now: Date): Promise<{ saved: string[]; failed: string[] }> {
  const at = bucketStart(now);
  const saved: string[] = [];
  const failed: string[] = [];
  for (const userId of await deps.users()) {
    try {
      const [p, terms] = await Promise.all([deps.portfolio(userId), deps.floorTerms(userId)]);
      await deps.save(snapshotOf(userId, at, p, terms));
      saved.push(userId);
    } catch (e) {
      failed.push(userId);
      deps.log?.("equity_snapshot_failed", { userId, error: String(e).slice(0, 300) });
    }
  }
  return { saved, failed };
}

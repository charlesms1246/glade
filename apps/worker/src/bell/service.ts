import { currentClosure, type Closure, type ClosureKind } from "@glade/calendar";
import { closeSnapshot, gapBand, impliedOpen } from "@glade/engine";
import { dec, type Decimal } from "@glade/shared";
import type { PriceCache } from "../market/price-cache";

export interface SnapshotRow {
  symbol: string;
  closePx: string;
  markPx: string;
  basis: string;
}

export interface BellRepo {
  /** Idempotent on closeAt. */
  upsertSession(c: Closure): Promise<string>;
  listSnapshots(sessionId: string): Promise<SnapshotRow[]>;
  /** Idempotent on (sessionId, symbol). */
  saveSnapshot(sessionId: string, row: SnapshotRow): Promise<void>;
}

/** Last traded price strictly before `at` (e.g. from 1-minute history). */
export type PriceBefore = (symbol: string, cls: "spot" | "perp", at: Date) => Promise<string | null>;

export interface BellEstimate {
  symbol: string;
  close: string;
  markNow: string;
  impliedOpen: string;
  gap: string;
  band: string;
  markAt: string;
}

export interface BellTick {
  closure: Closure | null;
  sessionId: string | null;
  snapshotsTaken: string[];
  estimates: BellEstimate[];
}

export interface BellServiceOptions {
  repo: BellRepo;
  cache: PriceCache;
  priceBefore: PriceBefore;
  /** Calibrated σ of the implied-open error by closure kind. */
  sigma: Record<ClosureKind, Decimal>;
  /** z for the ± band. */
  z?: Decimal;
  /** Wait this long after the close before snapshotting, so the last pre-close minute is final. */
  settleMs?: number;
  maxMarkAgeMs?: number;
}

export function createBellService(o: BellServiceOptions) {
  const settle = o.settleMs ?? 60_000;
  const maxAge = o.maxMarkAgeMs ?? 60_000;

  async function tick(symbols: readonly string[], now: Date): Promise<BellTick> {
    const closure = currentClosure(now);
    if (!closure) return { closure: null, sessionId: null, snapshotsTaken: [], estimates: [] };
    const sessionId = await o.repo.upsertSession(closure);
    const have = new Map((await o.repo.listSnapshots(sessionId)).map((s) => [s.symbol, s]));
    const taken: string[] = [];

    if (now.getTime() - closure.closeAt.getTime() >= settle) {
      for (const symbol of symbols) {
        if (have.has(symbol)) continue;
        const [close, mark] = await Promise.all([
          o.priceBefore(symbol, "spot", closure.closeAt),
          o.priceBefore(symbol, "perp", closure.closeAt),
        ]);
        if (!close || !mark) continue;
        const snap = closeSnapshot(close, mark);
        const row = { symbol, closePx: snap.close.toString(), markPx: snap.mark.toString(), basis: snap.basis.toString() };
        await o.repo.saveSnapshot(sessionId, row);
        have.set(symbol, row);
        taken.push(symbol);
      }
    }

    const band = gapBand(o.sigma[closure.kind], o.z ?? dec(1));
    const estimates: BellEstimate[] = [];
    for (const symbol of symbols) {
      const snap = have.get(symbol);
      const mark = o.cache.fresh(symbol, "perp", now, maxAge);
      if (!snap || !mark) continue;
      const implied = impliedOpen(mark.px, snap.basis);
      estimates.push({
        symbol,
        close: snap.closePx,
        markNow: mark.px.toString(),
        impliedOpen: implied.toFixed(4),
        gap: implied.div(dec(snap.closePx)).minus(1).toFixed(6),
        band: band.toFixed(6),
        markAt: mark.at.toISOString(),
      });
    }
    return { closure, sessionId, snapshotsTaken: taken, estimates };
  }

  return { tick };
}

export function memoryBellRepo(): BellRepo & { sessions: Map<string, Closure>; snaps: Map<string, SnapshotRow[]> } {
  const sessions = new Map<string, Closure>();
  const snaps = new Map<string, SnapshotRow[]>();
  return {
    sessions,
    snaps,
    async upsertSession(c) {
      const id = c.closeAt.toISOString();
      if (!sessions.has(id)) sessions.set(id, c);
      return id;
    },
    async listSnapshots(id) {
      return [...(snaps.get(id) ?? [])];
    },
    async saveSnapshot(id, row) {
      const list = snaps.get(id) ?? [];
      if (!list.some((r) => r.symbol === row.symbol)) list.push(row);
      snaps.set(id, list);
    },
  };
}

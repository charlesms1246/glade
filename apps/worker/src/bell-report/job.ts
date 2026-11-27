import type { ClosureKind } from "@glade/calendar";
import { dec, type Decimal } from "@glade/shared";
import { computeHedgeReport, explainReport, type Fill, type HedgeReport, type Snapshot } from "./compute";

/** Minutes after the open at which the realised open price is read (matches the Bell unwind). */
export const OPEN_READ_MIN = 5;
/** A hedge that still cannot be reported this long after the open is given up on. */
export const GIVE_UP_AFTER_MS = 24 * 60 * 60_000;

export interface PendingBellHedge {
  hedgeId: string;
  userId: string;
  sessionId: string;
  sessionKind: ClosureKind;
  openAt: Date;
  openedAt: Date;
  closedAt: Date;
  /** inputs.plan of the hedge's open intent (the plan the user approved). */
  plan: unknown;
  fills: Fill[];
}

export interface BellReportRow {
  userId: string;
  sessionId: string;
  estGapUsd: string;
  realGapUsd: string;
  savedUsd: string;
  costUsd: string;
  accuracyBp: string;
}

export interface BellReportJobDeps {
  /** Closed Bell hedges whose (user, session) has no bell_reports row yet. */
  pending: () => Promise<PendingBellHedge[]>;
  snapshots: (sessionId: string) => Promise<Snapshot[]>;
  /** Spot price at `at` (last 1m close at or before it), or null if not available yet. */
  spotPriceAt: (symbol: string, at: Date) => Promise<string | null>;
  /** Net paper funding received by the user's position in `assetId` between from and to. */
  fundingReceived: (userId: string, assetId: string, from: Date, to: Date) => Promise<string>;
  /** Insert; returns false if a report for (user, session) already exists. */
  insertReport: (row: BellReportRow) => Promise<boolean>;
  logDecision: (userId: string, d: { action: string; explanation: string; inputs: unknown; outputs: unknown }) => Promise<void>;
  sigma: Record<ClosureKind, Decimal>;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

const s = (d: Decimal) => d.toFixed();

function outputs(r: HedgeReport) {
  return {
    estGapUsd: s(r.estGapUsd),
    realGapUsd: s(r.realGapUsd),
    savedUsd: s(r.savedUsd),
    costUsd: s(r.costUsd),
    accuracyBp: s(r.accuracyBp),
    legs: r.legs.map((l) => ({
      symbol: l.symbol,
      holding: l.holding,
      estGap: s(l.estGap),
      estSource: l.estSource,
      realisedGap: s(l.realisedGap),
      hedgePnl: s(l.hedgePnl),
      cost: s(l.cost),
      saved: s(l.saved),
      accuracyBp: s(l.accuracyBp),
    })),
  };
}

/** Write one Bell report per closed Bell hedge once the post-open price exists. Safe to re-run. */
export async function runBellReportJob(deps: BellReportJobDeps, now: Date): Promise<{ reported: string[]; waiting: string[] }> {
  const reported: string[] = [];
  const waiting: string[] = [];
  for (const h of await deps.pending()) {
    const giveUp = async (reason: string) => {
      if (now.getTime() < h.openAt.getTime() + GIVE_UP_AFTER_MS) return false;
      await deps.logDecision(h.userId, {
        action: "bell_report_unavailable",
        explanation: "No Bell report for this hedge: the post-open price or the pre-close snapshot was not available within 24 hours.",
        inputs: { hedgeId: h.hedgeId, sessionId: h.sessionId, reason },
        outputs: {},
      });
      return true;
    };
    try {
      const readAt = new Date(h.openAt.getTime() + OPEN_READ_MIN * 60_000);
      if (now < readAt) {
        waiting.push(h.hedgeId);
        continue;
      }
      const snapshots = await deps.snapshots(h.sessionId);
      const legs = (h.plan as { legs?: { symbol?: unknown; reduceOnly?: unknown }[] } | null)?.legs ?? [];
      const hedged = new Set(legs.filter((l) => l.reduceOnly === false).map((l) => l.symbol));
      const openPx: Record<string, string> = {};
      for (const sn of snapshots.filter((x) => hedged.has(x.symbol))) {
        const px = await deps.spotPriceAt(sn.symbol, readAt);
        if (px) openPx[sn.symbol] = px;
      }
      const fundingReceived: Record<string, string> = {};
      for (const assetId of new Set(h.fills.map((f) => f.assetId))) {
        fundingReceived[assetId] = await deps.fundingReceived(h.userId, assetId, h.openedAt, h.closedAt);
      }
      const r = computeHedgeReport({ plan: h.plan, fills: h.fills, snapshots, openPx, fundingReceived });
      if (typeof r === "string") {
        deps.log?.("bell_report_waiting", { hedgeId: h.hedgeId, reason: r });
        if (!(await giveUp(r))) waiting.push(h.hedgeId);
        continue;
      }
      const out = outputs(r);
      const inserted = await deps.insertReport({
        userId: h.userId,
        sessionId: h.sessionId,
        estGapUsd: out.estGapUsd,
        realGapUsd: out.realGapUsd,
        savedUsd: out.savedUsd,
        costUsd: out.costUsd,
        accuracyBp: out.accuracyBp,
      });
      if (!inserted) continue;
      await deps.logDecision(h.userId, {
        action: "bell_report",
        explanation: explainReport(r, deps.sigma[h.sessionKind] ?? dec(0)),
        inputs: { hedgeId: h.hedgeId, sessionId: h.sessionId, readAt: readAt.toISOString(), openPx, fundingReceived, fills: h.fills, snapshots },
        outputs: out,
      });
      reported.push(h.hedgeId);
    } catch (e) {
      deps.log?.("bell_report_failed", { hedgeId: h.hedgeId, error: String(e).slice(0, 300) });
      await giveUp(`error: ${String(e).slice(0, 200)}`).catch(() => undefined);
    }
  }
  return { reported, waiting };
}

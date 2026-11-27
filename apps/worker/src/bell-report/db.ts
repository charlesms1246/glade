import type { ClosureKind } from "@glade/calendar";
import { schema, type Db } from "@glade/db";
import { and, asc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Fill, Snapshot } from "./compute";
import type { BellReportJobDeps, BellReportRow, PendingBellHedge } from "./job";

const { bellReports, bellSessions, bellSnapshots, hedges, intents, orders, paperLedger } = schema;

/** Closed Bell hedges without a report, with the session found by id or, if unset, by opened_at. */
export async function pendingBellHedges(db: Db, limit = 50): Promise<PendingBellHedge[]> {
  const rows = await db
    .select({
      hedgeId: hedges.id,
      userId: hedges.userId,
      openedAt: hedges.openedAt,
      closedAt: hedges.closedAt,
      sessionId: bellSessions.id,
      sessionKind: bellSessions.kind,
      openAt: bellSessions.openAt,
    })
    .from(hedges)
    .innerJoin(
      bellSessions,
      or(
        eq(hedges.bellSessionId, bellSessions.id),
        and(isNull(hedges.bellSessionId), sql`${bellSessions.closeAt} < ${hedges.openedAt}`, sql`${hedges.openedAt} < ${bellSessions.openAt}`),
      ),
    )
    .leftJoin(bellReports, and(eq(bellReports.userId, hedges.userId), eq(bellReports.sessionId, bellSessions.id)))
    .where(
      and(
        eq(hedges.mode, "bell"),
        eq(hedges.status, "closed"),
        isNull(bellReports.id),
        // Hedges the job gave up on are not retried.
        sql`not exists (select 1 from decisions d where d.action = 'bell_report_unavailable' and d.inputs->>'hedgeId' = ${hedges.id}::text)`,
      ),
    )
    .orderBy(asc(hedges.closedAt))
    .limit(limit);

  const ready = rows.filter((r) => r.openedAt && r.closedAt);
  const allFills =
    ready.length === 0
      ? []
      : await db
          .select({ hedgeId: intents.hedgeId, assetId: intents.assetId, kind: intents.kind, inputs: intents.inputs, qty: orders.executedQty, px: orders.avgPrice, fee: orders.fee })
          .from(orders)
          .innerJoin(intents, eq(intents.id, orders.intentId))
          .where(and(inArray(intents.hedgeId, ready.map((r) => r.hedgeId)), eq(orders.status, "complete")));
  const out: PendingBellHedge[] = [];
  for (const r of ready) {
    const fillRows = allFills.filter((f) => f.hedgeId === r.hedgeId);
    const fills: Fill[] = fillRows
      .filter((f) => f.qty !== null && f.px !== null && (f.kind === "open" || f.kind === "close"))
      .map((f) => ({ assetId: f.assetId, kind: f.kind as "open" | "close", executedQty: f.qty!, avgPrice: f.px!, fee: f.fee ?? "0" }));
    const plan = (fillRows.find((f) => f.kind === "open")?.inputs as { plan?: unknown } | null)?.plan;
    out.push({
      hedgeId: r.hedgeId,
      userId: r.userId,
      sessionId: r.sessionId,
      sessionKind: r.sessionKind as ClosureKind,
      openAt: r.openAt,
      openedAt: r.openedAt!,
      closedAt: r.closedAt!,
      plan,
      fills,
    });
  }
  return out;
}

export async function sessionSnapshots(db: Db, sessionId: string): Promise<Snapshot[]> {
  return db
    .select({ symbol: bellSnapshots.symbol, closePx: bellSnapshots.closePx, basis: bellSnapshots.basis })
    .from(bellSnapshots)
    .where(eq(bellSnapshots.sessionId, sessionId));
}

/** Sum of paper funding ledger rows (positive = received) for one position over [from, to]. */
export async function paperFundingReceived(db: Db, userId: string, assetId: string, from: Date, to: Date): Promise<string> {
  const [r] = await db
    .select({ total: sql<string>`coalesce(sum(${paperLedger.amountUsd}), 0)::text` })
    .from(paperLedger)
    .where(
      and(eq(paperLedger.userId, userId), eq(paperLedger.assetId, assetId), eq(paperLedger.kind, "funding"), gte(paperLedger.at, from), lte(paperLedger.at, to)),
    );
  return r?.total ?? "0";
}

export async function insertBellReport(db: Db, row: BellReportRow): Promise<boolean> {
  const r = await db.insert(bellReports).values(row).onConflictDoNothing().returning({ id: bellReports.id });
  return r.length > 0;
}

/** The database half of BellReportJobDeps; the caller adds prices, decisions and sigma. */
export function bellReportDb(db: Db): Pick<BellReportJobDeps, "pending" | "snapshots" | "fundingReceived" | "insertReport"> {
  return {
    pending: () => pendingBellHedges(db),
    snapshots: (id) => sessionSnapshots(db, id),
    fundingReceived: (u, a, f, t) => paperFundingReceived(db, u, a, f, t),
    insertReport: (row) => insertBellReport(db, row),
  };
}

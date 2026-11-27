import "server-only";
import type { ClosureKind } from "@glade/calendar";
import { sql } from "drizzle-orm";
import { cacheLife } from "next/cache";
import { bandFor } from "./bell";
import { aggregateBell, type BellAggregate, type ReportLeg } from "./bell-summary";
import { db } from "./db";

export interface BellReportCard {
  closeAt: string;
  openAt: string;
  kind: ClosureKind;
  legs: ReportLeg[];
  estGapUsd: string;
  realGapUsd: string;
  costUsd: string;
  savedUsd: string;
}

interface Row extends Record<string, unknown> {
  close_at: Date;
  open_at: Date;
  kind: ClosureKind;
  est_gap_usd: string;
  real_gap_usd: string;
  cost_usd: string;
  saved_usd: string;
  outputs: { legs?: { symbol: string; estGap: string; realisedGap: string; hedgePnl: string }[] } | null;
  estimates: { symbol: string; band?: string }[] | null;
}

/** Bell report cards, newest closure first: one user's when `userId` is set, else everyone's (no identifiers returned). */
export async function bellReports(userId: string | null, limit = 50): Promise<BellReportCard[]> {
  const rows = (await db().execute<Row>(sql`
    select bs.close_at, bs.open_at, bs.kind, br.est_gap_usd, br.real_gap_usd, br.cost_usd, br.saved_usd, d.outputs, est.estimates
    from bell_reports br
    join bell_sessions bs on bs.id = br.session_id
    left join lateral (
      select outputs, inputs from decisions
      where user_id = br.user_id and action = 'bell_report' and inputs->>'sessionId' = br.session_id::text
      order by at desc limit 1
    ) d on true
    left join lateral (
      select inputs->'plan'->'estimates' as estimates from intents
      where hedge_id::text = d.inputs->>'hedgeId' and kind = 'open' limit 1
    ) est on true
    where ${userId}::uuid is null or br.user_id = ${userId}::uuid
    order by bs.close_at desc
    limit ${limit}`)) as unknown as Row[];

  return rows.map((r) => {
    const bands = new Map((Array.isArray(r.estimates) ? r.estimates : []).map((e) => [e.symbol, e.band ?? null]));
    return {
      closeAt: new Date(r.close_at).toISOString(),
      openAt: new Date(r.open_at).toISOString(),
      kind: r.kind,
      legs: (r.outputs?.legs ?? []).map((l) => ({
        symbol: l.symbol,
        estGap: l.estGap,
        realisedGap: l.realisedGap,
        band: bands.get(l.symbol) ?? bandFor(r.kind).toFixed(6),
        hedgePnl: l.hedgePnl,
      })),
      estGapUsd: r.est_gap_usd,
      realGapUsd: r.real_gap_usd,
      costUsd: r.cost_usd,
      savedUsd: r.saved_usd,
    };
  });
}

export async function bellAggregate(): Promise<BellAggregate> {
  "use cache";
  cacheLife("minutes");
  return aggregateBell(await bellReports(null, 500));
}

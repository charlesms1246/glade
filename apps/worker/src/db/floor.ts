import { schema, type Db } from "@glade/db";
import { usersWithoutPaperAccount } from "@glade/paper";
import { Decimal } from "@glade/shared";
import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { FloorDecision, FloorDraft } from "../floor/decide";
import type { FloorUser } from "../floor/job";

const { mandates, floorState, intents, hedges, appUsers, tmUsers } = schema;

export async function activeFloorUsers(db: Db): Promise<FloorUser[]> {
  const rows = await db
    .select({ m: mandates, s: floorState })
    .from(mandates)
    .leftJoin(floorState, eq(floorState.userId, mandates.userId))
    .where(eq(mandates.status, "active"));
  return rows.map(({ m, s }) => ({
    userId: m.userId,
    mandate: {
      floorPct: m.floorPct,
      multiplier: m.multiplier,
      ratchet: m.ratchet,
      baseUsd: m.baseUsd,
      leverageMax: m.leverageMax,
      allowedPerps: m.allowedPerps,
      maxTradesDay: m.maxTradesDay,
    },
    state: {
      peak: s?.peakUsd ? new Decimal(s.peakUsd) : null,
      lastTradeAt: s?.lastTradeAt ?? null,
      tradesToday: s?.tradesToday ?? 0,
      tradesDay: s?.tradesDay ?? null,
    },
  }));
}

export async function saveFloorState(
  db: Db,
  userId: string,
  s: { peak: string; lastTradeAt: Date | null; tradesDay: string; tradesToday: number },
): Promise<void> {
  const values = { peakUsd: s.peak, lastTradeAt: s.lastTradeAt, tradesDay: s.tradesDay, tradesToday: s.tradesToday, updatedAt: new Date() };
  await db.insert(floorState).values({ userId, ...values }).onConflictDoUpdate({ target: floorState.userId, set: values });
}

export async function hasOpenIntents(db: Db, userId: string): Promise<boolean> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(intents)
    .where(and(eq(intents.userId, userId), inArray(intents.status, ["pending", "executing"])));
  return (r?.n ?? 0) > 0;
}

/** Automation intents under the user's Floor hedge (created on first use). */
export async function insertFloorIntents(db: Db, userId: string, drafts: FloorDraft[], d: Pick<FloorDecision, "explanation"> & Partial<Pick<FloorDecision, "cppi">>): Promise<void> {
  await db.transaction(async (tx) => {
    let [h] = await tx
      .select({ id: hedges.id })
      .from(hedges)
      .where(and(eq(hedges.userId, userId), eq(hedges.mode, "floor"), inArray(hedges.status, ["planned", "active", "unwinding"])));
    if (!h) [h] = await tx.insert(hedges).values({ userId, mode: "floor", status: "planned", legs: [] }).returning({ id: hedges.id });
    await tx.insert(intents).values(
      drafts.map((x) => ({
        userId,
        hedgeId: h!.id,
        kind: x.kind,
        assetId: x.assetId,
        side: x.side,
        qty: x.qty,
        qtyUnit: "base",
        leverage: x.leverage,
        reduceOnly: x.reduceOnly,
        reason: d.explanation,
        inputs: {
          source: "automation",
          notionalUsd: x.notionalUsd,
          beta: x.beta,
          ...(d.cppi ? { cppi: { floor: d.cppi.floor.toString(), cushionRatio: d.cppi.cushionRatio.toString(), hedgeTarget: d.cppi.hedgeTarget.toString() } } : {}),
        },
      })),
    );
  });
}

/** Users missing a paper account, plus (when allowed) users without a Gateway user. */
export async function pendingOnboarding(db: Db, limit: number, includeGateway: boolean, exclude: string[] = []): Promise<{ id: string }[]> {
  const noPaper = await usersWithoutPaperAccount(db, limit, exclude);
  const noTm = includeGateway
    ? (
        await db
          .select({ id: appUsers.id })
          .from(appUsers)
          .leftJoin(tmUsers, eq(tmUsers.userId, appUsers.id))
          .where(and(isNull(tmUsers.userId), exclude.length ? notInArray(appUsers.id, exclude) : undefined))
          .orderBy(appUsers.createdAt)
          .limit(limit)
      ).map((r) => r.id)
    : [];
  return [...new Set([...noPaper, ...noTm])].slice(0, limit).map((id) => ({ id }));
}

/**
 * The Floor's own short size per perp: filled automation sells minus reduce-only buys on the user's
 * Floor hedge. Shield and Bell hedges on the same perp are not counted, so Floor never trims them.
 */
export async function floorHedgeSizes(db: Db, userId: string): Promise<Record<string, string>> {
  const rows = await db.execute<{ asset_id: string; size: string }>(sql`
    select i.asset_id,
      sum(case when i.side = 'sell' then o.executed_qty else -o.executed_qty end)::text as size
    from intents i
    join hedges h on h.id = i.hedge_id and h.mode = 'floor'
    join orders o on o.intent_id = i.id and o.status = 'complete'
    where i.user_id = ${userId}
    group by i.asset_id`);
  return Object.fromEntries((rows as unknown as { asset_id: string; size: string }[]).map((r) => [r.asset_id, r.size]));
}

/**
 * Floor shorts left open for users with no active mandate (paused or revoked): owned size per user and perp.
 * Only the net filled Floor size counts, so Shield and Bell hedges are never touched.
 */
export async function strandedFloorHedges(db: Db): Promise<Map<string, Record<string, string>>> {
  const rows = await db.execute<{ user_id: string; asset_id: string; size: string }>(sql`
    select i.user_id, i.asset_id,
      sum(case when i.side = 'sell' then o.executed_qty else -o.executed_qty end)::text as size
    from intents i
    join hedges h on h.id = i.hedge_id and h.mode = 'floor'
    join orders o on o.intent_id = i.id and o.status = 'complete'
    where not exists (select 1 from mandates m where m.user_id = i.user_id and m.status = 'active')
    group by i.user_id, i.asset_id
    having sum(case when i.side = 'sell' then o.executed_qty else -o.executed_qty end) > 0`);
  const out = new Map<string, Record<string, string>>();
  for (const r of rows as unknown as { user_id: string; asset_id: string; size: string }[]) {
    out.set(r.user_id, { ...(out.get(r.user_id) ?? {}), [r.asset_id]: r.size });
  }
  return out;
}

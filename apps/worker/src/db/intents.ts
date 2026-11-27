import { schema, type Db } from "@glade/db";
import { and, eq, gte, inArray, ne, sql } from "drizzle-orm";
import type { ExecResult } from "../executor/types";
import type { CloseIntentDraft } from "../jobs/bell-unwind";
import { explainResult, type ClaimedIntent } from "../jobs/intent-runner";
import type { IntentRow, SignedMandate, StoredPasskey } from "../policy/authorize";
import { Decimal } from "@glade/shared";
import { logDecision, publish } from "./repos";

const { intents, orders, hedges, passkeys, mandates, assetRegistry } = schema;

/** Atomically claim pending intents (oldest first); concurrent workers never claim the same row. */
export async function claimIntents(db: Db, limit: number): Promise<ClaimedIntent[]> {
  const rows = await db.execute<{ id: string }>(sql`
    update intents set status = 'executing'
    where id in (
      select id from intents where status = 'pending' order by created_at limit ${limit} for update skip locked
    )
    returning id`);
  const ids = (rows as unknown as { id: string }[]).map((r) => r.id);
  if (ids.length === 0) return [];
  const full = await db.select().from(intents).where(inArray(intents.id, ids));
  return full
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((r) => ({
      id: r.id,
      userId: r.userId,
      kind: r.kind,
      assetId: r.assetId,
      side: r.side,
      qty: r.qty,
      qtyUnit: r.qtyUnit as "base" | "quote",
      leverage: r.leverage,
      reduceOnly: r.reduceOnly,
      planHash: r.planHash,
      inputs: r.inputs,
      hedgeId: r.hedgeId,
      reason: r.reason,
    }));
}

export async function recordIntentResult(db: Db, engineVersion: string, i: ClaimedIntent, r: ExecResult): Promise<void> {
  // The executor sets the intent status itself; this keeps a status for paths that threw before it could.
  if (r.outcome === "failed") await db.update(intents).set({ status: "failed" }).where(and(eq(intents.id, i.id), eq(intents.status, "executing")));

  if (i.hedgeId && r.outcome === "complete") {
    if (i.kind === "open" || i.kind === "increase") {
      await db.update(hedges).set({ status: "active", openedAt: new Date() }).where(and(eq(hedges.id, i.hedgeId), inArray(hedges.status, ["planned", "active"])));
    } else if (i.kind === "close") {
      const [h] = await db.select({ mode: hedges.mode }).from(hedges).where(eq(hedges.id, i.hedgeId));
      // Bell hedges are finalised by the unwind job once every filled leg has a filled close.
      if (h?.mode === "bell") return finishRecord(db, engineVersion, i, r);
      const open = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(intents)
        .where(and(eq(intents.hedgeId, i.hedgeId), eq(intents.kind, "close"), inArray(intents.status, ["pending", "executing"])));
      if ((open[0]?.n ?? 0) === 0) await db.update(hedges).set({ status: "closed", closedAt: new Date() }).where(eq(hedges.id, i.hedgeId));
      else await db.update(hedges).set({ status: "unwinding" }).where(eq(hedges.id, i.hedgeId));
    }
  }
  if (i.hedgeId && i.kind === "open" && r.outcome !== "complete" && r.outcome !== "unknown") {
    await db.update(hedges).set({ status: "failed" }).where(and(eq(hedges.id, i.hedgeId), eq(hedges.status, "planned")));
  }

  await finishRecord(db, engineVersion, i, r);
}

async function finishRecord(db: Db, engineVersion: string, i: ClaimedIntent, r: ExecResult): Promise<void> {
  const explanation = explainResult(i, r);
  await logDecision(db, {
    userId: i.userId,
    engineVersion,
    action: `intent_${r.outcome}`,
    explanation,
    inputs: { intentId: i.id, kind: i.kind, assetId: i.assetId, side: i.side, qty: i.qty, reduceOnly: i.reduceOnly },
    outputs: r,
  });
  await publish(db, { type: "intent", data: { userId: i.userId, intentId: i.id, outcome: r.outcome, explanation } });
}

export function policyQueries(db: Db) {
  return {
    async getPasskey(userId: string, credentialId: string): Promise<StoredPasskey | null> {
      const [p] = await db
        .select()
        .from(passkeys)
        .where(and(eq(passkeys.userId, userId), eq(passkeys.credentialId, credentialId)));
      return p ? { credentialId: p.credentialId, publicKey: p.publicKey, transports: p.transports } : null;
    },
    async getActiveMandate(userId: string): Promise<SignedMandate | null> {
      const [m] = await db
        .select()
        .from(mandates)
        .where(and(eq(mandates.userId, userId), eq(mandates.status, "active")));
      if (!m) return null;
      const n = (v: string) => new Decimal(v).toString();
      return {
        id: m.id,
        status: m.status,
        allowedPerps: m.allowedPerps,
        leverageMax: m.leverageMax,
        maxTradesDay: m.maxTradesDay,
        // Numeric columns come back padded to scale 18; normalise so the hash matches what was signed.
        terms: {
          userId: m.userId,
          version: m.version,
          floorPct: n(m.floorPct),
          multiplier: n(m.multiplier),
          ratchet: m.ratchet,
          baseUsd: n(m.baseUsd),
          leverageMax: n(m.leverageMax),
          allowedPerps: m.allowedPerps,
          maxTradesDay: m.maxTradesDay,
        },
        storedHash: m.mandateHash,
        approval: m.webauthnAssertion,
      };
    },
    /** Completed automation orders since UTC midnight; the user's own trades do not use the mandate's cap. */
    async tradesToday(userId: string, now: Date): Promise<number> {
      const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const [r] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(orders)
        .innerJoin(intents, eq(orders.intentId, intents.id))
        .where(
          and(
            eq(intents.userId, userId),
            eq(orders.status, "complete"),
            gte(orders.finalAt, midnight),
            sql`${intents.inputs}->>'source' = 'automation'`,
          ),
        );
      return r?.n ?? 0;
    },
    async assetType(assetId: string): Promise<"spot" | "perp" | null> {
      const [r] = await db.select({ type: assetRegistry.type }).from(assetRegistry).where(eq(assetRegistry.assetId, assetId)).limit(1);
      return r?.type === "spot" || r?.type === "perp" ? r.type : null;
    },
    async liveSiblings(row: IntentRow): Promise<number> {
      if (!row.planHash) return 0;
      const [r] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(intents)
        .where(
          and(
            eq(intents.planHash, row.planHash),
            eq(intents.assetId, row.assetId),
            eq(intents.side, row.side),
            eq(intents.reduceOnly, row.reduceOnly),
            eq(intents.qty, row.qty),
            ne(intents.id, row.id),
            inArray(intents.status, ["pending", "executing", "done"]),
          ),
        );
      return r?.n ?? 0;
    },
  };
}

/** Max close attempts per Bell leg before the worker stops retrying and raises an alert. */
export const MAX_CLOSE_ATTEMPTS = 3;

/**
 * Bell hedges to unwind now: active hedges past unwind_at with no closes yet, and unwinding hedges
 * whose closes all ended without filling every leg (retried up to MAX_CLOSE_ATTEMPTS per leg).
 */
export async function dueBellHedges(db: Db, now: Date) {
  const rows = await db.execute<{
    hedge_id: string;
    user_id: string;
    inputs: unknown;
    plan_hash: string;
    done_opens: { assetId: string; qty: string }[];
    done_closes: { assetId: string; qty: string }[];
    failed_closes: number;
    failed_by_leg: { assetId: string; qty: string; n: number }[];
  }>(sql`
    select h.id as hedge_id, h.user_id, o.inputs, o.plan_hash,
      coalesce((select json_agg(json_build_object('assetId', i.asset_id, 'qty', i.qty::text)) from intents i
        where i.hedge_id = h.id and i.kind = 'open' and i.status = 'done'), '[]') as done_opens,
      coalesce((select json_agg(json_build_object('assetId', i.asset_id, 'qty', i.qty::text)) from intents i
        where i.hedge_id = h.id and i.kind = 'close' and i.status = 'done'), '[]') as done_closes,
      (select count(*)::int from intents i where i.hedge_id = h.id and i.kind = 'close' and i.status in ('failed', 'rejected')) as failed_closes,
      coalesce((select json_agg(json_build_object('assetId', f.asset_id, 'qty', f.qty::text, 'n', f.n)) from (
        select i.asset_id, i.qty, count(*)::int as n from intents i
        where i.hedge_id = h.id and i.kind = 'close' and i.status in ('failed', 'rejected') group by i.asset_id, i.qty) f), '[]') as failed_by_leg
    from hedges h
    join lateral (
      select inputs, plan_hash from intents where hedge_id = h.id and kind = 'open' and status = 'done' limit 1
    ) o on true
    where h.mode = 'bell' and h.unwind_at <= ${now.toISOString()}::timestamptz
      and (h.status = 'active' or h.status = 'unwinding')
      and not exists (select 1 from intents c where c.hedge_id = h.id and c.kind = 'close' and c.status in ('pending', 'executing'))`);
  type Row = { hedge_id: string; user_id: string; inputs: unknown; plan_hash: string; done_opens: { assetId: string; qty: string }[]; done_closes: { assetId: string; qty: string }[]; failed_closes: number; failed_by_leg: { assetId: string; qty: string; n: number }[] };
  return (rows as unknown as Row[]).map((r) => ({
    hedgeId: r.hedge_id,
    userId: r.user_id,
    openInputs: r.inputs,
    planHash: r.plan_hash,
    doneOpens: r.done_opens,
    doneCloses: r.done_closes,
    failedCloses: r.failed_closes,
    failedByLeg: r.failed_by_leg,
  }));
}

export async function insertCloseIntents(db: Db, drafts: CloseIntentDraft[]): Promise<void> {
  if (drafts.length === 0) return;
  await db.transaction(async (tx) => {
    await tx.insert(intents).values(drafts);
    await tx.update(hedges).set({ status: "unwinding" }).where(eq(hedges.id, drafts[0]!.hedgeId));
  });
}

/**
 * Intents stuck in "executing" (worker crashed or an order outcome was unknown). Returned for another
 * executor pass, which only polls an order that may already be live and never re-executes it.
 * Only the leader worker (advisory lock) runs this, so no two processes reclaim the same intent.
 */
export async function reclaimStale(db: Db, olderThanMs: number, limit: number): Promise<ClaimedIntent[]> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const rows = await db.execute<{ id: string }>(sql`
    select i.id from intents i
    where i.status = 'executing' and i.created_at < ${cutoff.toISOString()}::timestamptz
      and not exists (
        select 1 from orders o where o.intent_id = i.id and o.created_at >= ${cutoff.toISOString()}::timestamptz
      )
    order by i.created_at limit ${limit}`);
  const ids = (rows as unknown as { id: string }[]).map((r) => r.id);
  if (ids.length === 0) return [];
  const full = await db.select().from(intents).where(inArray(intents.id, ids));
  return full.map((r) => ({
    id: r.id,
    userId: r.userId,
    kind: r.kind,
    assetId: r.assetId,
    side: r.side,
    qty: r.qty,
    qtyUnit: r.qtyUnit as "base" | "quote",
    leverage: r.leverage,
    reduceOnly: r.reduceOnly,
    planHash: r.planHash,
    inputs: r.inputs,
    hedgeId: r.hedgeId,
    reason: r.reason,
  }));
}

/** True when a decision with this action was already written for the hedge (keeps alerts to one per hedge). */
export async function hedgeHasDecision(db: Db, action: string, hedgeId: string): Promise<boolean> {
  const rows = await db.execute(sql`select 1 from decisions where action = ${action} and inputs->>'hedgeId' = ${hedgeId} limit 1`);
  return (rows as unknown as unknown[]).length > 0;
}

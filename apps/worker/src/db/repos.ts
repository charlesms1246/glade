import type { Closure } from "@glade/calendar";
import { schema, type Db } from "@glade/db";
import { and, eq, sql } from "drizzle-orm";
import type { BellRepo } from "../bell/service";
import type { ExecutorRepo, OrderRow } from "../executor/types";

const { orders, intents, bellSessions, bellSnapshots, decisions } = schema;

export function executorRepo(db: Db): ExecutorRepo {
  const toRow = (o: typeof orders.$inferSelect): OrderRow => ({
    intentId: o.intentId,
    attempt: o.attempt,
    tmOrderId: o.tmOrderId,
    status: o.status,
    executedQty: o.executedQty,
    avgPrice: o.avgPrice,
    fee: o.fee,
    explorerUrl: o.explorerUrl,
    raw: o.raw,
  });
  return {
    async listOrders(intentId) {
      return (await db.select().from(orders).where(eq(orders.intentId, intentId))).map(toRow);
    },
    async insertOrder(row) {
      // The unique (intent_id, attempt) index makes a concurrent duplicate fail here.
      await db.insert(orders).values({ intentId: row.intentId, attempt: row.attempt, tmOrderId: row.tmOrderId, status: row.status });
    },
    async updateOrder(intentId, attempt, patch) {
      const final = patch.status && ["complete", "canceled", "failed", "failed_funding"].includes(patch.status);
      await db
        .update(orders)
        .set({ ...patch, ...(final ? { finalAt: new Date() } : {}) })
        .where(and(eq(orders.intentId, intentId), eq(orders.attempt, attempt)));
    },
    async setIntentStatus(intentId, status) {
      await db.update(intents).set({ status }).where(eq(intents.id, intentId));
    },
  };
}

export function bellRepo(db: Db): BellRepo {
  return {
    async upsertSession(c: Closure) {
      const [row] = await db
        .insert(bellSessions)
        .values({ closeAt: c.closeAt, openAt: c.openAt, kind: c.kind })
        .onConflictDoUpdate({ target: bellSessions.closeAt, set: { openAt: c.openAt } })
        .returning({ id: bellSessions.id });
      return row!.id;
    },
    async listSnapshots(sessionId) {
      const rows = await db.select().from(bellSnapshots).where(eq(bellSnapshots.sessionId, sessionId));
      return rows.map((r) => ({ symbol: r.symbol, closePx: r.closePx, markPx: r.markPx, basis: r.basis }));
    },
    async saveSnapshot(sessionId, row) {
      await db
        .insert(bellSnapshots)
        .values({ sessionId, symbol: row.symbol, closePx: row.closePx, markPx: row.markPx, basis: row.basis })
        .onConflictDoNothing();
    },
  };
}

export interface DecisionInput {
  userId: string | null;
  engineVersion: string;
  action: string;
  explanation: string;
  inputs: unknown;
  outputs: unknown;
}

export async function logDecision(db: Db, d: DecisionInput): Promise<void> {
  await db.insert(decisions).values({ ...d, inputs: d.inputs ?? {}, outputs: d.outputs ?? {} });
}

/** Push an event to the web app's SSE stream (LISTEN glade_events). Payloads stay well under the 8 kB NOTIFY limit. */
export async function publish(db: Db, event: { type: string; data: unknown }): Promise<void> {
  await db.execute(sql`select pg_notify('glade_events', ${JSON.stringify(event)})`);
}

/** Single leader across worker instances. Returns false if another worker holds the lock. */
export async function tryLeaderLock(db: Db): Promise<boolean> {
  const r = await db.execute<{ locked: boolean }>(sql`select pg_try_advisory_lock(hashtext('glade-worker')) as locked`);
  return Boolean((r as unknown as { locked: boolean }[])[0]?.locked);
}

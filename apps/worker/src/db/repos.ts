import type { Closure } from "@glade/calendar";
import { schema, type Db } from "@glade/db";
import { and, eq, sql } from "drizzle-orm";
import type { BellRepo } from "../bell/service";
import type { ExecutorRepo, OrderRow } from "../executor/types";
import type { OnboardingRepo } from "../onboarding/onboard";

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
    createdAtMs: o.createdAt.getTime(),
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

export function onboardingRepo(db: Db): OnboardingRepo {
  const { signerKeys, tmUsers } = schema;
  return {
    async getSigner(userId) {
      const [r] = await db.select().from(signerKeys).where(eq(signerKeys.userId, userId));
      if (!r || r.revokedAt) return null;
      return {
        publicKeyHex: r.publicKeyHex,
        sealed: { alg: "AES-256-GCM", encPrivateKey: r.encPrivateKey, iv: r.iv, encDataKey: r.encDataKey, dataKeyIv: r.dataKeyIv },
      };
    },
    async saveSigner(userId, env, s) {
      // Primary key on user_id: a second key for the same user fails instead of silently replacing a live one.
      // A revoked key is replaced, otherwise that user could never be onboarded again.
      const row = { userId, env, publicKeyHex: s.publicKeyHex, ...s.sealed };
      await db
        .insert(signerKeys)
        .values(row)
        .onConflictDoUpdate({ target: signerKeys.userId, set: { ...row, revokedAt: null }, setWhere: sql`${signerKeys.revokedAt} is not null` });
    },
    async getTmUser(userId) {
      const [r] = await db.select().from(tmUsers).where(eq(tmUsers.userId, userId));
      return r ? { tmUserId: r.tmUserId, externalRefId: r.externalRefId, solanaAddress: r.solanaAddress, evmAddress: r.evmAddress } : null;
    },
    async saveTmUser(userId, env, rec) {
      await db
        .insert(tmUsers)
        .values({ userId, env, ...rec })
        .onConflictDoUpdate({ target: tmUsers.userId, set: { solanaAddress: rec.solanaAddress, evmAddress: rec.evmAddress } });
    },
  };
}

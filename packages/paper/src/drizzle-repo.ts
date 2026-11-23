import { schema, type Db } from "@glade/db";
import { dec, type TmEnv } from "@glade/shared";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { AssetRegistry, PaperAsset, PaperOrder, PaperRepo, PaperState } from "./types";

const { appUsers, assetRegistry, paperAccounts, paperHoldings, paperLedger, paperOrders, paperPositions, signerKeys } = schema;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Conn = Db | Tx;

// numeric columns come back as "10.000000000000000000"; normalise for display and equality.
const n = (v: string) => dec(v).toFixed();
const nOrNull = (v: string | null) => (v === null ? null : n(v));

function toOrder(r: typeof paperOrders.$inferSelect): PaperOrder {
  return {
    id: r.id,
    userId: r.userId,
    assetId: r.assetId,
    side: r.side,
    qty: n(r.qty),
    qtyUnit: r.qtyUnit as PaperOrder["qtyUnit"],
    leverage: r.leverage,
    reduceOnly: r.reduceOnly,
    status: r.status as PaperOrder["status"],
    payload: r.payload,
    quotePrice: n(r.quotePrice),
    createdAt: r.createdAt.getTime(),
    executedQty: nOrNull(r.executedQty),
    executedVwap: nOrNull(r.executedVwap),
    fee: nOrNull(r.fee),
    failureReason: r.failureReason,
    executedAt: r.executedAt?.getTime() ?? null,
  };
}

function orderRow(o: PaperOrder): typeof paperOrders.$inferInsert {
  return {
    ...o,
    createdAt: new Date(o.createdAt),
    executedAt: o.executedAt === null ? null : new Date(o.executedAt),
  };
}

async function getOrder(c: Conn, id: string): Promise<PaperOrder | null> {
  const [r] = await c.select().from(paperOrders).where(eq(paperOrders.id, id));
  return r ? toOrder(r) : null;
}

async function loadState(c: Conn, userId: string): Promise<PaperState | null> {
  const [acct] = await c.select().from(paperAccounts).where(eq(paperAccounts.userId, userId));
  if (!acct) return null;
  const holdings = await c.select().from(paperHoldings).where(eq(paperHoldings.userId, userId));
  const positions = await c.select().from(paperPositions).where(eq(paperPositions.userId, userId));
  return {
    cashUsd: n(acct.cashUsd),
    fundingHour: acct.fundingHour,
    holdings: Object.fromEntries(holdings.map((h) => [h.assetId, n(h.qty)])),
    positions: Object.fromEntries(
      positions.map((p) => [
        p.assetId,
        { assetId: p.assetId, size: n(p.size), entryPrice: n(p.entryPrice), margin: n(p.margin), leverage: p.leverage },
      ]),
    ),
  };
}

/** Postgres PaperRepo. update() holds a per-user advisory lock, so it also serialises account creation. */
export function drizzlePaperRepo(db: Db): PaperRepo {
  return {
    async signerPublicKey(userId) {
      const [r] = await db
        .select({ pk: signerKeys.publicKeyHex })
        .from(signerKeys)
        .where(and(eq(signerKeys.userId, userId), isNull(signerKeys.revokedAt)));
      return r?.pk ?? null;
    },
    load: (userId) => loadState(db, userId),
    update(userId, fn) {
      return db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`paper:${userId}`}))`);
        const res = await fn(await loadState(tx, userId), { getOrder: (id) => getOrder(tx, id) });
        if (res === null) return null;
        const s = res.state;
        await tx
          .insert(paperAccounts)
          .values({ userId, cashUsd: s.cashUsd, fundingHour: s.fundingHour })
          .onConflictDoUpdate({
            target: paperAccounts.userId,
            set: { cashUsd: s.cashUsd, fundingHour: s.fundingHour, updatedAt: new Date() },
          });
        await tx.delete(paperHoldings).where(eq(paperHoldings.userId, userId));
        const holdings = Object.entries(s.holdings).map(([assetId, qty]) => ({ userId, assetId, qty }));
        if (holdings.length) await tx.insert(paperHoldings).values(holdings);
        await tx.delete(paperPositions).where(eq(paperPositions.userId, userId));
        const positions = Object.values(s.positions).map((p) => ({ userId, ...p }));
        if (positions.length) await tx.insert(paperPositions).values(positions);
        if (res.ledger.length) {
          await tx.insert(paperLedger).values(
            res.ledger.map((e) => ({
              userId,
              at: new Date(e.at),
              kind: e.kind,
              amountUsd: e.amountUsd,
              assetId: e.assetId,
              orderId: e.orderId,
              meta: e.meta ?? null,
            })),
          );
        }
        for (const o of res.orders ?? []) {
          const row = orderRow(o);
          await tx.insert(paperOrders).values(row).onConflictDoUpdate({ target: paperOrders.id, set: row });
        }
        return res.result;
      });
    },
    async insertOrder(order) {
      await db.insert(paperOrders).values(orderRow(order));
    },
    getOrder: (id) => getOrder(db, id),
  };
}

/** Asset lookup from asset_registry for one environment, cached per process (ids are stable). */
export function drizzleRegistry(db: Db, env: TmEnv): AssetRegistry {
  const cache = new Map<string, PaperAsset | null>();
  return async (assetId) => {
    if (cache.has(assetId)) return cache.get(assetId)!;
    const [r] = await db
      .select()
      .from(assetRegistry)
      .where(and(eq(assetRegistry.env, env), eq(assetRegistry.assetId, assetId)));
    const a: PaperAsset | null =
      r && (r.type === "spot" || r.type === "perp")
        ? {
            assetId: r.assetId,
            symbol: r.symbol,
            type: r.type,
            assetClass: r.assetClass === "crypto" ? "crypto" : "stock",
            maxLeverage: r.maxLeverage,
            economicAssetId: r.economicAssetId,
            venue: r.venue,
            chain: r.chain,
          }
        : null;
    if (a) cache.set(assetId, a);
    return a;
  };
}

/** App users that have no paper account yet (for the onboarding job). */
export async function usersWithoutPaperAccount(db: Db, limit: number): Promise<string[]> {
  const rows = await db
    .select({ id: appUsers.id })
    .from(appUsers)
    .leftJoin(paperAccounts, eq(paperAccounts.userId, appUsers.id))
    .where(isNull(paperAccounts.userId))
    .orderBy(asc(appUsers.createdAt))
    .limit(limit);
  return rows.map((r) => r.id);
}

/** Recent paper ledger rows for a user, newest first. */
export async function paperLedgerFor(db: Db, userId: string, limit = 50) {
  return db
    .select()
    .from(paperLedger)
    .where(eq(paperLedger.userId, userId))
    .orderBy(sql`${paperLedger.at} desc, ${paperLedger.id} desc`)
    .limit(limit);
}

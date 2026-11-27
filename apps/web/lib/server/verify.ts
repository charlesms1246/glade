import "server-only";
import { schema } from "@glade/db";
import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import { cacheLife } from "next/cache";
import { db, tmEnv } from "./db";

export interface PaperFill {
  at: string;
  side: "buy" | "sell";
  symbol: string;
  instrument: "spot" | "perp";
  qty: string;
  price: string | null;
  fee: string | null;
  /** Which feature placed it, e.g. "Shield", "Bell · close", "Buy". */
  mode: string;
}

export interface VerifyStats {
  gatewayUsers: number;
  paperAccounts: number;
  intents: Record<string, number>;
  completedOrders: number;
  recent: PaperFill[];
}

const MODE = { shield: "Shield", floor: "Floor", bell: "Bell" } as const;

/** Aggregate, identifier-free activity for the public verification page. */
export async function verifyStats(): Promise<VerifyStats> {
  "use cache";
  cacheLife("minutes");
  const o = schema.orders;
  const i = schema.intents;
  const a = schema.assetRegistry;
  const h = schema.hedges;
  const [[gw], [paper], byStatus, [done], recent] = await Promise.all([
    db().select({ n: count() }).from(schema.tmUsers),
    db().select({ n: count() }).from(schema.paperAccounts),
    db().select({ status: i.status, n: count() }).from(i).groupBy(i.status),
    db().select({ n: count() }).from(o).where(eq(o.status, "complete")),
    db()
      .select({
        at: o.finalAt,
        side: i.side,
        kind: i.kind,
        symbol: a.symbol,
        type: a.type,
        qty: o.executedQty,
        price: o.avgPrice,
        fee: o.fee,
        mode: h.mode,
      })
      .from(o)
      .innerJoin(i, eq(o.intentId, i.id))
      .leftJoin(a, and(eq(a.env, tmEnv()), eq(a.assetId, i.assetId)))
      .leftJoin(h, eq(h.id, i.hedgeId))
      .where(and(eq(o.status, "complete"), sql`${o.finalAt} is not null`))
      .orderBy(desc(o.finalAt))
      .limit(10),
  ]);
  const trim = (v: string | null) => (v === null ? null : v.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ""));
  return {
    gatewayUsers: gw?.n ?? 0,
    paperAccounts: paper?.n ?? 0,
    intents: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
    completedOrders: done?.n ?? 0,
    recent: recent.map((r) => ({
      at: r.at!.toISOString(),
      side: r.side,
      symbol: r.symbol ?? "?",
      instrument: r.type === "perp" ? "perp" : "spot",
      qty: trim(r.qty === null ? null : Number(r.qty) >= 1 ? Number(r.qty).toFixed(4) : Number(r.qty).toPrecision(4)) ?? "0",
      price: trim(r.price),
      fee: trim(r.fee),
      mode: `${r.mode ? MODE[r.mode] : r.kind === "spot_buy" ? "Buy" : r.kind === "spot_sell" ? "Sell" : "Hedge"}${r.kind === "close" ? " · close" : r.kind === "decrease" ? " · trim" : ""}`,
    })),
  };
}

export interface RecentOrder {
  at: string;
  symbol: string;
  side: "buy" | "sell";
  qty: string;
  price: string | null;
  status: string;
  reduceOnly: boolean;
  /** "Your approval", or the automation that placed it. */
  source: string;
}

const trimNum = (v: string | null) => (v === null ? null : v.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ""));

/** The last 20 paper orders across all users, without any user, wallet or plan identifier. */
export async function recentOrders(): Promise<RecentOrder[]> {
  "use cache";
  cacheLife("minutes");
  const p = schema.paperOrders;
  const rows = await db()
    .select({
      at: p.createdAt,
      symbol: schema.assetRegistry.symbol,
      side: p.side,
      qty: p.executedQty,
      reqQty: p.qty,
      price: p.executedVwap,
      status: p.status,
      reduceOnly: p.reduceOnly,
      planHash: schema.intents.planHash,
      mode: schema.hedges.mode,
    })
    .from(p)
    .leftJoin(schema.orders, eq(schema.orders.tmOrderId, p.id))
    .leftJoin(schema.intents, eq(schema.intents.id, schema.orders.intentId))
    .leftJoin(schema.hedges, eq(schema.hedges.id, schema.intents.hedgeId))
    .leftJoin(schema.assetRegistry, and(eq(schema.assetRegistry.env, tmEnv()), eq(schema.assetRegistry.assetId, p.assetId)))
    .orderBy(desc(p.createdAt))
    .limit(20);
  return rows.map((r) => ({
    at: r.at.toISOString(),
    symbol: r.symbol ?? "?",
    side: r.side,
    qty: trimNum(Number(r.qty ?? r.reqQty) >= 1 ? Number(r.qty ?? r.reqQty).toFixed(4) : Number(r.qty ?? r.reqQty).toPrecision(4)) ?? "0",
    price: trimNum(r.price),
    status: r.status,
    reduceOnly: r.reduceOnly,
    source: r.planHash ? "Your approval" : r.mode === "floor" ? "Floor automation" : r.mode === "bell" ? "Bell automation" : "Automation",
  }));
}

export interface ApiCallRow {
  method: string;
  route: string;
  today: Record<string, number>;
  total: Record<string, number>;
}

export interface ApiCallStats {
  env: "uat" | "prod";
  rows: ApiCallRow[];
  todayTotal: number;
  total: number;
}

/** True Markets API call counts by endpoint: today (UTC day) and since launch. */
export async function apiCallStats(): Promise<ApiCallStats> {
  "use cache";
  cacheLife("minutes");
  const t = schema.tmApiCalls;
  const since = new Date().toISOString().slice(0, 10);
  const all = await db()
    .select({
      method: t.method,
      route: t.route,
      cls: t.statusClass,
      total: sql<number>`sum(${t.count})::int`,
      recent: sql<number>`coalesce(sum(${t.count}) filter (where ${gte(t.day, since)}), 0)::int`,
    })
    .from(t)
    .groupBy(t.method, t.route, t.statusClass);
  const byKey = new Map<string, ApiCallRow>();
  let todayTotal = 0;
  let total = 0;
  for (const r of all) {
    const key = `${r.method} ${r.route}`;
    const row = byKey.get(key) ?? { method: r.method, route: r.route, today: {}, total: {} };
    row.total[r.cls] = r.total;
    if (r.recent) row.today[r.cls] = r.recent;
    byKey.set(key, row);
    total += r.total;
    todayTotal += r.recent;
  }
  const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
  return { env: tmEnv(), rows: [...byKey.values()].sort((a, b) => sum(b.total) - sum(a.total)), todayTotal, total };
}

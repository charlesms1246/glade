import "server-only";
import { schema } from "@glade/db";
import { and, count, desc, eq, sql } from "drizzle-orm";
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

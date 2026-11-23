import "server-only";
import { schema } from "@glade/db";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "./db";
import type { PlanBase } from "./plans";

export interface ActivityItem {
  id: string;
  at: string;
  type: "order" | "decision";
  title: string;
  explanation: string;
  status: string | null;
  fill: { qty: string | null; price: string | null; fee: string | null; explorerUrl: string | null } | null;
}

const KIND_TEXT: Record<string, string> = {
  spot_buy: "Buy",
  spot_sell: "Sell",
  open: "Open hedge",
  increase: "Raise hedge",
  decrease: "Trim hedge",
  close: "Close hedge",
};

/** The user's orders (intents with their latest attempt) and engine decisions, newest first. */
export async function activity(userId: string, limit = 50): Promise<ActivityItem[]> {
  const [intents, decisions] = await Promise.all([
    db().select().from(schema.intents).where(eq(schema.intents.userId, userId)).orderBy(desc(schema.intents.createdAt)).limit(limit),
    db().select().from(schema.decisions).where(eq(schema.decisions.userId, userId)).orderBy(desc(schema.decisions.at)).limit(limit),
  ]);
  const orders = intents.length
    ? await db().select().from(schema.orders).where(inArray(schema.orders.intentId, intents.map((i) => i.id)))
    : [];
  const latest = new Map<string, (typeof orders)[number]>();
  for (const o of orders) if ((latest.get(o.intentId)?.attempt ?? -1) < o.attempt) latest.set(o.intentId, o);

  const items: ActivityItem[] = [
    ...intents.map((i): ActivityItem => {
      const o = latest.get(i.id);
      const plan = (i.inputs as { plan?: PlanBase }).plan;
      const symbol = plan?.legs.find((l) => l.assetId === i.assetId)?.symbol ?? "";
      const amount = i.qtyUnit === "quote" ? `${i.qty} USD of` : i.qty;
      return {
        id: `i:${i.id}`,
        at: i.createdAt.toISOString(),
        type: "order",
        title: `${KIND_TEXT[i.kind] ?? i.kind}: ${i.side} ${amount} ${symbol}${i.kind === "spot_buy" || i.kind === "spot_sell" ? "" : " perp"}`.trim(),
        explanation: i.reason,
        status: o?.status ?? i.status,
        fill: o ? { qty: o.executedQty, price: o.avgPrice, fee: o.fee, explorerUrl: o.explorerUrl } : null,
      };
    }),
    ...decisions.map(
      (d): ActivityItem => ({
        id: `d:${d.id}`,
        at: d.at.toISOString(),
        type: "decision",
        title: d.action.replaceAll("_", " "),
        explanation: d.explanation,
        status: null,
        fill: null,
      }),
    ),
  ];
  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

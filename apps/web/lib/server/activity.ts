import "server-only";
import { schema } from "@glade/db";
import { dec } from "@glade/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import { decisionTitle, orderTitle } from "./activity-title";
import { db, tmEnv } from "./db";
import type { PlanBase } from "./plans";

export interface ActivityItem {
  id: string;
  at: string;
  type: "order" | "decision";
  /** The hedge an order belongs to, when it has one. */
  hedgeId: string | null;
  title: string;
  explanation: string;
  status: string | null;
  fill: { qty: string | null; price: string | null; fee: string | null; explorerUrl: string | null } | null;
}

/** The user's orders (intents with their latest attempt) and engine decisions, newest first. */
export async function activity(userId: string, limit = 50): Promise<ActivityItem[]> {
  const [intents, decisions] = await Promise.all([
    db().select().from(schema.intents).where(eq(schema.intents.userId, userId)).orderBy(desc(schema.intents.createdAt)).limit(limit),
    db().select().from(schema.decisions).where(eq(schema.decisions.userId, userId)).orderBy(desc(schema.decisions.at)).limit(limit),
  ]);
  const orders = intents.length
    ? await db().select().from(schema.orders).where(inArray(schema.orders.intentId, intents.map((i) => i.id)))
    : [];
  const assetIds = [...new Set(intents.map((i) => i.assetId))];
  const symbols = new Map(
    (assetIds.length
      ? await db()
          .select({ id: schema.assetRegistry.assetId, symbol: schema.assetRegistry.symbol })
          .from(schema.assetRegistry)
          .where(and(eq(schema.assetRegistry.env, tmEnv()), inArray(schema.assetRegistry.assetId, assetIds)))
      : []
    ).map((r) => [r.id, r.symbol]),
  );
  const latest = new Map<string, (typeof orders)[number]>();
  for (const o of orders) if ((latest.get(o.intentId)?.attempt ?? -1) < o.attempt) latest.set(o.intentId, o);

  const items: ActivityItem[] = [
    ...intents.map((i): ActivityItem => {
      const o = latest.get(i.id);
      const plan = (i.inputs as { plan?: PlanBase }).plan;
      const symbol = plan?.legs?.find((l) => l.assetId === i.assetId)?.symbol ?? symbols.get(i.assetId) ?? "";
      return {
        id: `i:${i.id}`,
        at: i.createdAt.toISOString(),
        type: "order",
        hedgeId: i.hedgeId ?? null,
        title: orderTitle(i.kind, dec(i.qty).toFixed(), i.qtyUnit, symbol),
        explanation: i.reason,
        status: o?.status ?? i.status,
        fill: o ? { qty: o.executedQty && dec(o.executedQty).toFixed(), price: o.avgPrice, fee: o.fee, explorerUrl: o.explorerUrl } : null,
      };
    }),
    ...decisions.map(
      (d): ActivityItem => ({
        id: `d:${d.id}`,
        at: d.at.toISOString(),
        type: "decision",
        hedgeId: null,
        title: decisionTitle(d.action),
        explanation: d.explanation,
        status: null,
        fill: null,
      }),
    ),
  ];
  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

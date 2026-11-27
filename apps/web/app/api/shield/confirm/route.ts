import { currentClosure } from "@glade/calendar";
import { schema } from "@glade/db";
import { dec, type Decimal } from "@glade/shared";
import { eq } from "drizzle-orm";
import { fail, json, withUser } from "@/lib/server/api";
import { readJson } from "@/lib/server/body";
import { db } from "@/lib/server/db";
import { bellPlanError, LEVERAGE_CAP, legsOverCap, maxOrderUsd } from "@/lib/server/plan-rules";
import { commitPlan, intentInputs, type ApprovalBody } from "@/lib/server/plans";
import type { ShieldPlan } from "@/lib/server/shield";
import { overHedgedPerps } from "@/lib/server/shield-sizing";
import { venueFor } from "@/lib/server/venue";

function validate(plan: ShieldPlan, closure: ReturnType<typeof currentClosure>, existing: ReadonlyMap<string, Decimal>): string | null {
  if (plan.kind !== "shield" && plan.kind !== "bell") return "Not a shield plan.";
  const opens = plan.legs.filter((l) => !l.reduceOnly);
  const closes = plan.legs.filter((l) => l.reduceOnly);
  const openOk = opens.every((l) => l.side === "sell" && l.qtyUnit === "base" && l.leverage && dec(l.leverage).lte(LEVERAGE_CAP));
  const closeOk = plan.kind === "bell" ? closes.length === opens.length && closes.every((l) => l.side === "buy") : closes.length === 0;
  if (!plan.ok || opens.length === 0 || !openOk || !closeOk) return "This plan cannot be placed.";
  if (legsOverCap(plan.legs, maxOrderUsd()).length) return "A leg is above the per-order limit.";
  if (overHedgedPerps(plan.rows, opens, existing).length) return "Your open shorts already cover this much of the stock. Review a fresh plan.";
  return plan.kind === "bell" ? bellPlanError(plan.unwindAt, closure) : null;
}

export async function POST(req: Request) {
  return withUser(async (uid) => {
    const body = (await readJson(req)) as ApprovalBody<ShieldPlan> | null;
    const closure = body?.plan?.kind === "bell" ? currentClosure(new Date()) : null;
    const [session] = closure
      ? await db().select({ id: schema.bellSessions.id }).from(schema.bellSessions).where(eq(schema.bellSessions.closeAt, closure.closeAt))
      : [];

    // Current shorts per perp symbol, so a stale plan cannot stack a second hedge on top.
    const existing = new Map<string, Decimal>();
    for (const p of await venueFor(uid).positions()) {
      if (p.side !== "short" || !p.symbol || !p.size) continue;
      existing.set(p.symbol, (existing.get(p.symbol) ?? dec(0)).plus(dec(p.size).mul(dec(p.mark_price ?? p.entry_price ?? "0"))));
    }

    const r = await commitPlan(uid, body, (plan) => validate(plan, closure, existing), async (tx, a) => {
      const { plan } = a;
      const [hedge] = await tx
        .insert(schema.hedges)
        .values({
          userId: uid,
          mode: plan.kind,
          status: "planned",
          targetRatio: plan.ratio,
          legs: plan.legs,
          unwindAt: plan.unwindAt ? new Date(plan.unwindAt) : null,
          bellSessionId: session?.id ?? null,
        })
        .returning({ id: schema.hedges.id });
      const until = plan.unwindAt ? ` until ${new Date(plan.unwindAt).toUTCString()}` : "";
      await tx.insert(schema.intents).values(
        plan.legs
          .filter((l) => !l.reduceOnly)
          .map((l) => ({
            userId: uid,
            hedgeId: hedge!.id,
            kind: "open" as const,
            assetId: l.assetId,
            side: "sell" as const,
            qty: l.qty,
            qtyUnit: "base",
            leverage: l.leverage!,
            reduceOnly: false,
            planHash: a.hash,
            reason: `You approved a ${Math.round(Number(plan.ratio) * 100)}% shield${until}: short ${l.qty} ${l.symbol} perp (about ${l.notionalUsd} USD) at ${l.leverage}× leverage.`,
            inputs: intentInputs(a, l.notionalUsd),
            status: "pending" as const,
          })),
      );
      return hedge!.id;
    });
    return r.ok ? json({ hedgeId: r.result }) : fail(400, r.error);
  });
}

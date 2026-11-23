import { currentClosure } from "@glade/calendar";
import { schema } from "@glade/db";
import { dec } from "@glade/shared";
import { eq } from "drizzle-orm";
import { fail, json, withUser } from "@/lib/server/api";
import { db } from "@/lib/server/db";
import { approvePlan, intentInputs, type ApprovalBody } from "@/lib/server/plans";
import type { ShieldPlan } from "@/lib/server/shield";

const MAX_LEVERAGE = 3;

export async function POST(req: Request) {
  return withUser(async (uid) => {
    const a = await approvePlan(uid, (await req.json().catch(() => null)) as ApprovalBody<ShieldPlan> | null);
    if (!a.ok) return fail(400, a.error);
    const { plan } = a;
    if (plan.kind !== "shield" && plan.kind !== "bell") return fail(400, "Not a shield plan.");
    const opens = plan.legs.filter((l) => !l.reduceOnly);
    const closes = plan.legs.filter((l) => l.reduceOnly);
    const openOk = opens.every((l) => l.side === "sell" && l.qtyUnit === "base" && l.leverage && dec(l.leverage).lte(MAX_LEVERAGE));
    const closeOk = plan.kind === "bell" ? closes.length === opens.length && closes.every((l) => l.side === "buy") : closes.length === 0;
    if (!plan.ok || opens.length === 0 || !openOk || !closeOk) return fail(400, "This plan cannot be placed.");

    const closure = plan.kind === "bell" ? currentClosure(new Date()) : null;
    const [session] = closure
      ? await db().select({ id: schema.bellSessions.id }).from(schema.bellSessions).where(eq(schema.bellSessions.closeAt, closure.closeAt))
      : [];

    const hedgeId = await db().transaction(async (tx) => {
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
        opens.map((l) => ({
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
    return json({ hedgeId });
  });
}

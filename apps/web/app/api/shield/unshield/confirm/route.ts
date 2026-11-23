import { schema } from "@glade/db";
import { fail, json, withUser } from "@/lib/server/api";
import { db } from "@/lib/server/db";
import { approvePlan, intentInputs, type ApprovalBody } from "@/lib/server/plans";
import type { UnshieldPlan } from "@/lib/server/shield";
import { readJson } from "@/lib/server/body";

export async function POST(req: Request) {
  return withUser(async (uid) => {
    const a = await approvePlan(uid, (await readJson(req)) as ApprovalBody<UnshieldPlan> | null);
    if (!a.ok) return fail(400, a.error);
    const { plan } = a;
    if (plan.kind !== "unshield" || plan.legs.length === 0 || !plan.legs.every((l) => l.side === "buy" && l.reduceOnly)) {
      return fail(400, "Not an unshield plan.");
    }
    await db()
      .insert(schema.intents)
      .values(
        plan.legs.map((l) => ({
          userId: uid,
          hedgeId: plan.hedgeId,
          kind: "close" as const,
          assetId: l.assetId,
          side: "buy" as const,
          qty: l.qty,
          qtyUnit: "base",
          reduceOnly: true,
          planHash: a.hash,
          reason: `You approved closing your ${l.symbol} hedge: buy back ${l.qty} (about ${l.notionalUsd} USD), reduce-only.`,
          inputs: intentInputs(a, l.notionalUsd),
          status: "pending" as const,
        })),
      );
    return json({ ok: true });
  });
}

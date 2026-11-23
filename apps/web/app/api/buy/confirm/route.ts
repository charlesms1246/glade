import { schema } from "@glade/db";
import { fail, json, withUser } from "@/lib/server/api";
import type { BuyPlan } from "@/lib/server/buy";
import { db } from "@/lib/server/db";
import { approvePlan, intentInputs, type ApprovalBody } from "@/lib/server/plans";

export async function POST(req: Request) {
  return withUser(async (uid) => {
    const a = await approvePlan(uid, (await req.json().catch(() => null)) as ApprovalBody<BuyPlan> | null);
    if (!a.ok) return fail(400, a.error);
    const { plan } = a;
    const leg = plan.legs[0];
    if (plan.kind !== "spot_buy" || plan.legs.length !== 1 || !leg || leg.side !== "buy") return fail(400, "Not a buy plan.");
    const [row] = await db()
      .insert(schema.intents)
      .values({
        userId: uid,
        kind: "spot_buy",
        assetId: leg.assetId,
        side: "buy",
        qty: leg.qty,
        qtyUnit: "quote",
        reduceOnly: false,
        planHash: a.hash,
        reason: `You approved buying ${plan.usd} USD of ${plan.symbol} at about ${plan.price} USD per share, with an estimated fee of ${plan.feeUsd} USD.`,
        inputs: intentInputs(a, leg.notionalUsd),
        status: "pending",
      })
      .returning({ id: schema.intents.id });
    return json({ intentId: row!.id });
  });
}

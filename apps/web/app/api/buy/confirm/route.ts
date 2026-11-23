import { schema } from "@glade/db";
import { fail, json, withUser } from "@/lib/server/api";
import { readJson } from "@/lib/server/body";
import type { BuyPlan } from "@/lib/server/buy";
import { legsOverCap, maxOrderUsd } from "@/lib/server/plan-rules";
import { commitPlan, intentInputs, type ApprovalBody } from "@/lib/server/plans";

export async function POST(req: Request) {
  return withUser(async (uid) => {
    const r = await commitPlan(
      uid,
      (await readJson(req)) as ApprovalBody<BuyPlan> | null,
      (plan) => {
        const leg = plan.legs[0];
        if (plan.kind !== "spot_buy" || plan.legs.length !== 1 || !leg || leg.side !== "buy") return "Not a buy plan.";
        return legsOverCap(plan.legs, maxOrderUsd()).length ? "This order is above the per-order limit." : null;
      },
      async (tx, a) => {
        const { plan } = a;
        const leg = plan.legs[0]!;
        const [row] = await tx
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
        return row!.id;
      },
    );
    return r.ok ? json({ intentId: r.result }) : fail(400, r.error);
  });
}

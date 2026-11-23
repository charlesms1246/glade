import { schema } from "@glade/db";
import { fail, json, withUser } from "@/lib/server/api";
import { readJson } from "@/lib/server/body";
import { commitPlan, intentInputs, type ApprovalBody } from "@/lib/server/plans";
import type { UnshieldPlan } from "@/lib/server/shield";

export async function POST(req: Request) {
  return withUser(async (uid) => {
    const r = await commitPlan(
      uid,
      (await readJson(req)) as ApprovalBody<UnshieldPlan> | null,
      (plan) => (plan.kind !== "unshield" || plan.legs.length === 0 || !plan.legs.every((l) => l.side === "buy" && l.reduceOnly && l.hedgeId) ? "Not an unshield plan." : null),
      async (tx, a) => {
        const { plan } = a;
        await tx.insert(schema.intents).values(
          plan.legs.map((l) => ({
            userId: uid,
            hedgeId: l.hedgeId,
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
      },
    );
    return r.ok ? json({ ok: true }) : fail(400, r.error);
  });
}

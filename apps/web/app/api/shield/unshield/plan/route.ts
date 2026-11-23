import { fail, json, withUser } from "@/lib/server/api";
import { offerPlan } from "@/lib/server/plans";
import { buildUnshieldPlan } from "@/lib/server/shield";

export async function POST() {
  return withUser(async (uid) => {
    const plan = await buildUnshieldPlan(uid);
    if ("error" in plan) return fail(422, plan.error);
    return json(await offerPlan(plan));
  });
}

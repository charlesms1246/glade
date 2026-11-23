import { z } from "zod";
import { fail, json, withUser } from "@/lib/server/api";
import { offerPlan } from "@/lib/server/plans";
import { buildShieldPlan } from "@/lib/server/shield";

const body = z.object({
  ratio: z.string().regex(/^(0(\.\d{1,4})?|1(\.0{1,4})?)$/, "Ratio must be between 0 and 1."),
  kind: z.enum(["shield", "bell"]).default("shield"),
});

export async function POST(req: Request) {
  return withUser(async (uid) => {
    const parsed = body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? "Invalid request.");
    const plan = await buildShieldPlan(uid, parsed.data.ratio, parsed.data.kind);
    if ("error" in plan) return fail(422, plan.error);
    return json(await offerPlan(plan));
  });
}

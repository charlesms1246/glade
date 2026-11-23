import { z } from "zod";
import { fail, json, withUser } from "@/lib/server/api";
import { buildBuyPlan } from "@/lib/server/buy";
import { offerPlan } from "@/lib/server/plans";
import { readJson } from "@/lib/server/body";

const body = z.object({
  symbol: z.string().min(1).max(20),
  usd: z.string().regex(/^\d{1,7}(\.\d{1,2})?$/, "Enter a dollar amount, e.g. 25 or 25.50."),
});

export async function POST(req: Request) {
  return withUser(async (uid) => {
    const parsed = body.safeParse(await readJson(req));
    if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? "Invalid request.");
    if (Number(parsed.data.usd) <= 0) return fail(400, "Enter an amount above zero.");
    const r = await buildBuyPlan(uid, parsed.data.symbol, parsed.data.usd);
    if ("error" in r) return fail(422, r.error);
    return json(await offerPlan(r.plan));
  });
}

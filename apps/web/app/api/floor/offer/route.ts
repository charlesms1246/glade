import { z } from "zod";
import { fail, json, withUser } from "@/lib/server/api";
import { offerMandate, validChoice } from "@/lib/server/floor";

const decStr = z.string().regex(/^\d+(\.\d{1,4})?$/);
const body = z.object({ floorPct: decStr, multiplier: decStr, ratchet: z.boolean(), leverageMax: decStr });

export async function POST(req: Request) {
  return withUser(async (uid) => {
    const parsed = body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return fail(400, "Invalid mandate settings.");
    const bad = validChoice(parsed.data);
    if (bad) return fail(400, bad);
    const offer = await offerMandate(uid, parsed.data);
    if ("error" in offer) return fail(422, offer.error!);
    return json(offer);
  });
}

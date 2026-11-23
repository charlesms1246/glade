import { fail, json, withUser } from "@/lib/server/api";
import { signMandate } from "@/lib/server/floor";

export async function POST(req: Request) {
  return withUser(async (uid) => {
    const r = await signMandate(uid, await req.json().catch(() => null));
    return r.ok ? json({ mandateId: r.id }) : fail(400, r.error);
  });
}

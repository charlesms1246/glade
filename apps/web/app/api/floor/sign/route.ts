import { fail, json, withUser } from "@/lib/server/api";
import { signMandate } from "@/lib/server/floor";
import { readJson } from "@/lib/server/body";

export async function POST(req: Request) {
  return withUser(async (uid) => {
    const r = await signMandate(uid, await readJson(req));
    return r.ok ? json({ mandateId: r.id }) : fail(400, r.error);
  });
}

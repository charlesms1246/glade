import { fail, json, withUser } from "@/lib/server/api";
import { setMandateStatus } from "@/lib/server/floor";

export async function POST() {
  return withUser(async (uid) => ((await setMandateStatus(uid, "paused")) ? json({ ok: true }) : fail(409, "No mandate to change.")));
}

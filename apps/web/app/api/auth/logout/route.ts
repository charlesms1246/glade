import { json } from "@/lib/server/api";
import { endSession } from "@/lib/server/session";

export async function POST() {
  await endSession();
  return json({ ok: true });
}

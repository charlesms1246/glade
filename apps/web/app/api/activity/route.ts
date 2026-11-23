import { json, withUser } from "@/lib/server/api";
import { activity } from "@/lib/server/activity";

export async function GET() {
  return withUser(async (uid) => json({ items: await activity(uid) }));
}

import { equitySeries } from "@glade/paper";
import { json, withUser } from "@/lib/server/api";
import { db } from "@/lib/server/db";

const MAX_DAYS = 30;

/** The signed-in user's paper equity in 15-minute steps, with the Floor target when a mandate is active. */
export async function GET(req: Request) {
  return withUser(async (uid) => {
    const days = Math.min(MAX_DAYS, Math.max(1, Number(new URL(req.url).searchParams.get("days")) || 7));
    return json({ points: await equitySeries(db(), uid, days) });
  });
}

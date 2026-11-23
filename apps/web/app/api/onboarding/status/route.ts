import { schema } from "@glade/db";
import { eq } from "drizzle-orm";
import { json, withUser } from "@/lib/server/api";
import { db } from "@/lib/server/db";
import { venueFor } from "@/lib/server/venue";

export async function GET() {
  return withUser(async (uid) => {
    const [tm] = await db().select({ id: schema.tmUsers.tmUserId }).from(schema.tmUsers).where(eq(schema.tmUsers.userId, uid));
    if (!tm) return json({ ready: false });
    const p = await venueFor(uid).portfolio();
    return json({ ready: true, cashUsd: p.cash_usd ?? "0" });
  });
}

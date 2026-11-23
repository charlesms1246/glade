import { schema } from "@glade/db";
import { eq } from "drizzle-orm";
import { json, withUser } from "@/lib/server/api";
import { db } from "@/lib/server/db";
import { venueFor } from "@/lib/server/venue";

/** Ready once the paper account exists; the True Markets account link is optional. */
export async function GET() {
  return withUser(async (uid) => {
    const [[paper], [tm]] = await Promise.all([
      db().select({ id: schema.paperAccounts.userId }).from(schema.paperAccounts).where(eq(schema.paperAccounts.userId, uid)),
      db().select({ id: schema.tmUsers.tmUserId }).from(schema.tmUsers).where(eq(schema.tmUsers.userId, uid)),
    ]);
    if (!paper) return json({ ready: false });
    const p = await venueFor(uid).portfolio();
    return json({ ready: true, cashUsd: p.cash_usd ?? "0", tmLinked: Boolean(tm) });
  });
}

import { schema, type Db } from "@glade/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { EquityJobDeps, FloorTerms } from "./job";

const { floorState, mandates, paperAccounts, paperEquitySnapshots } = schema;

export async function activeFloorTerms(db: Db, userId: string): Promise<FloorTerms | null> {
  const [m] = await db
    .select({ floorPct: mandates.floorPct, ratchet: mandates.ratchet, baseUsd: mandates.baseUsd })
    .from(mandates)
    .where(and(eq(mandates.userId, userId), eq(mandates.status, "active")))
    .orderBy(desc(mandates.version))
    .limit(1);
  if (!m) return null;
  const [s] = await db.select({ peak: floorState.peakUsd }).from(floorState).where(eq(floorState.userId, userId));
  return { floorPct: m.floorPct, ratchet: m.ratchet, baseUsd: m.baseUsd, peakUsd: s?.peak ?? null };
}

/** The database half of EquityJobDeps; the caller adds `portfolio` (paper venue) and `log`. */
export function equityDb(db: Db): Pick<EquityJobDeps, "users" | "floorTerms" | "save"> {
  return {
    users: async (at) =>
      (
        await db
          .select({ id: paperAccounts.userId })
          .from(paperAccounts)
          .leftJoin(paperEquitySnapshots, and(eq(paperEquitySnapshots.userId, paperAccounts.userId), eq(paperEquitySnapshots.at, at)))
          .where(isNull(paperEquitySnapshots.userId))
      ).map((r) => r.id),
    floorTerms: (u) => activeFloorTerms(db, u),
    save: async (s) => {
      await db.insert(paperEquitySnapshots).values(s).onConflictDoNothing();
    },
  };
}

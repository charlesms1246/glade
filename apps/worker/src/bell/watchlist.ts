import { schema, type Db } from "@glade/db";
import { normalizeSymbol } from "@glade/engine";
import { and, eq } from "drizzle-orm";

/** Normalised stock symbols from held tokens that have a perp, in sorted order. */
export function heldBellSymbols(heldSymbols: readonly string[], perpSymbols: readonly string[]): string[] {
  const bases = new Set(perpSymbols.map((s) => s.toUpperCase()));
  const groups = new Set(heldSymbols.map((s) => normalizeSymbol(s, bases)));
  return [...groups].filter((g) => bases.has(g)).sort();
}

/** Symbols currently held in any paper account that Bell can estimate (a perp exists for them). */
export async function loadHeldBellSymbols(db: Db, tmEnv: "uat" | "prod"): Promise<string[]> {
  const { paperHoldings, assetRegistry: r } = schema;
  const held = await db
    .selectDistinct({ symbol: r.symbol })
    .from(paperHoldings)
    .innerJoin(r, and(eq(r.assetId, paperHoldings.assetId), eq(r.env, tmEnv), eq(r.type, "spot")));
  const perps = await db.select({ symbol: r.symbol }).from(r).where(and(eq(r.env, tmEnv), eq(r.type, "perp")));
  return heldBellSymbols(held.map((x) => x.symbol), perps.map((x) => x.symbol));
}

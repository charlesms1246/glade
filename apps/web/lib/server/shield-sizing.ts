import { dec, type Decimal } from "@glade/shared";

/** Mark drift allowed between planning and confirming when comparing hedged notional to capacity. */
const DRIFT = "1.02";

/**
 * The holding value to size a new short from, after counting what existing shorts already cover.
 * The target notional is ratio·β·V; `covered` is the part of it an existing short already provides.
 */
export function remainingValue(value: Decimal, beta: Decimal, ratio: Decimal, covered: Decimal): Decimal {
  if (ratio.lte(0) || beta.lte(0)) return value;
  const rest = value.minus(covered.div(ratio.mul(beta)));
  return rest.gt(0) ? rest : dec(0);
}

/**
 * Split each perp's existing short notional across the holding groups that hedge with it, in order, each group
 * absorbing at most its own target (ratio·β·V). Returns the notional covered per group.
 */
export function allocateExisting(
  groups: readonly { perpAssetId: string; value: Decimal; beta: Decimal }[],
  ratio: Decimal,
  existingByPerp: ReadonlyMap<string, Decimal>,
): Decimal[] {
  const left = new Map(existingByPerp);
  return groups.map((g) => {
    const target = ratio.mul(g.beta).mul(g.value);
    const avail = left.get(g.perpAssetId) ?? dec(0);
    const take = avail.lt(target) ? avail : target;
    left.set(g.perpAssetId, avail.minus(take));
    return take;
  });
}

/** Hedged share of hedge capacity (Σβ·V): existing plus new notional, as a ratio. */
export function hedgedShare(capacity: Decimal, notional: Decimal): Decimal {
  return capacity.gt(0) ? notional.div(capacity) : dec(0);
}

/**
 * Perp symbols whose existing shorts plus the plan's new shorts exceed 1.0× the capacity (Σβ·V of the
 * holdings hedged with that perp), allowing for mark drift. Empty when the plan is fine.
 */
export function overHedgedPerps(
  rows: readonly { perpSymbol: string; valueUsd: string; beta: string }[],
  newLegs: readonly { symbol: string; notionalUsd: string }[],
  existingBySymbol: ReadonlyMap<string, Decimal>,
): string[] {
  const cap = new Map<string, Decimal>();
  for (const r of rows) cap.set(r.perpSymbol, (cap.get(r.perpSymbol) ?? dec(0)).plus(dec(r.valueUsd).mul(r.beta)));
  const added = new Map<string, Decimal>();
  for (const l of newLegs) added.set(l.symbol, (added.get(l.symbol) ?? dec(0)).plus(l.notionalUsd));
  return [...added.keys()].filter((sym) => {
    const total = (existingBySymbol.get(sym) ?? dec(0)).plus(added.get(sym)!);
    return total.gt((cap.get(sym) ?? dec(0)).mul(DRIFT));
  });
}

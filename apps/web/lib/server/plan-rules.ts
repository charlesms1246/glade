import { dec } from "@glade/shared";

export const BELL_UNWIND_MIN = 5;

/** When a Bell hedge for this closure unwinds: a few minutes after the open. */
export const bellUnwindAt = (closure: { openAt: Date }) => new Date(closure.openAt.getTime() + BELL_UNWIND_MIN * 60_000).toISOString();

/** A Bell plan may be placed only during the closure it was planned for. */
export function bellPlanError(unwindAt: string | undefined, closure: { openAt: Date } | null): string | null {
  if (!closure) return "The market has opened; this Shield until the bell plan can no longer be placed.";
  if (unwindAt !== bellUnwindAt(closure)) return "This plan was made for a different market closure. Review a fresh one.";
  return null;
}

/** Legs whose notional exceeds the per-order limit. */
export const legsOverCap = <L extends { notionalUsd: string }>(legs: readonly L[], maxOrderUsd: string) =>
  legs.filter((l) => dec(l.notionalUsd).gt(dec(maxOrderUsd)));

export const maxOrderUsd = () => process.env.MAX_ORDER_USD ?? "10000";

"use client";

import { qty, usd } from "@/lib/client/format";
import { usePoll } from "@/lib/client/use-poll";
import type { ActivityItem } from "@/lib/server/activity";

const FILLED = ["complete", "done"];
const NOT_PLACED = ["failed", "rejected", "failed_funding", "canceled"];

/** Live fill state of the orders `match` selects, from the shared stream; flips to the fill price once they fill. */
export function FillStatus({ match, expected }: { match: (it: ActivityItem) => boolean; expected: number }) {
  const { data } = usePoll<{ items: ActivityItem[] }>("/api/activity");
  const mine = data?.items.filter((it) => it.type === "order" && match(it)) ?? [];
  const filled = mine.filter((it) => FILLED.includes(it.status ?? ""));
  const failed = mine.filter((it) => NOT_PLACED.includes(it.status ?? ""));
  if (failed.length > 0) return <p className="num mt-3 text-sm text-rose" role="status">{failed.length} order{failed.length > 1 ? "s" : ""} not placed. Activity shows why.</p>;
  if (filled.length >= expected) {
    return (
      <ul className="num mt-3 space-y-1 text-sm text-forest" role="status">
        {filled.map((it) => (
          <li key={it.id}>
            Filled {it.fill?.qty ? qty(it.fill.qty) : ""}
            {it.fill?.price ? ` @ ${usd(it.fill.price)}` : ""}
            {it.fill?.fee ? ` · fee ${usd(it.fill.fee, 4)}` : ""}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <p className="num mt-3 text-sm text-ink-soft" role="status">
      Waiting for fills: {filled.length} of {expected}
    </p>
  );
}

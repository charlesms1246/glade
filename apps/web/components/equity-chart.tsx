"use client";

import { usd } from "@/lib/client/format";
import { equityPaths, type SeriesPoint } from "@/lib/client/equity-path";
import { usePoll } from "@/lib/client/use-poll";

const W = 900;
const H = 220;

/** Paper equity over time, with the Floor target when a mandate is active. */
export function EquityChart({ days = 7 }: { days?: number }) {
  const { data } = usePoll<{ points: SeriesPoint[] }>(`/api/equity?days=${days}`, 120_000, false);
  if (!data) return <div className="h-56 animate-pulse rounded-xl bg-sand" aria-busy="true" />;
  const paths = equityPaths(data.points, W, H);
  if (!paths) {
    return (
      <p className="rounded-xl bg-sand p-6 text-sm text-ink-soft">
        Your equity line fills in as Glade records it every 15 minutes. Check back shortly.
      </p>
    );
  }
  const first = data.points[0]!;
  const last = data.points.at(-1)!;
  const hasFloor = paths.floor !== "";
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`Equity from ${usd(first.equityUsd)} to ${usd(last.equityUsd)}`}>
        {hasFloor && <path d={paths.floor} fill="none" stroke="var(--rose)" strokeDasharray="6 5" strokeWidth="1.5" />}
        <path d={paths.equity} fill="none" stroke="var(--forest)" strokeWidth="2.5" strokeLinejoin="round" />
      </svg>
      <figcaption className="mt-3 flex flex-wrap justify-between gap-2 text-xs text-ink-soft">
        <span>
          <span className="text-forest">━ Equity</span>
          {hasFloor && <span className="ml-4 text-rose">┅ Floor target</span>}
        </span>
        <span className="num">
          since {new Date(first.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} ·{" "}
          {usd(first.equityUsd)} → {usd(last.equityUsd)}
        </span>
      </figcaption>
    </figure>
  );
}

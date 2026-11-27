"use client";

import { useEffect, useState } from "react";
import { signedPct, usd } from "@/lib/client/format";
import type { BellView } from "@/lib/server/bell";


export function BellBoard({ initial }: { initial: BellView }) {
  const [view, setView] = useState(initial);
  const [updated, setUpdated] = useState<string>(initial.now);

  // Estimates move during a closure; while the market is open only a slow check for the next closure is needed.
  const closed = view.closure !== null;
  useEffect(() => {
    const load = async () => {
      if (document.hidden) return;
      try {
        const r = await fetch("/api/bell");
        if (r.ok) {
          const v = (await r.json()) as BellView;
          setView(v);
          setUpdated(v.now);
        }
      } catch {
        // Keep showing the last estimate; the next tick retries.
      }
    };
    const t = setInterval(load, closed ? 15_000 : 60_000);
    return () => clearInterval(t);
  }, [closed]);

  if (!view.closure) {
    return (
      <p className="rounded-2xl border border-sand-deep bg-white/70 p-6 text-ink-soft">
        The market is open. Bell starts estimating at the close, when the stock stops trading on NYSE and the perp keeps
        moving.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        {view.cards.map((c) => (
          <article key={c.symbol} className="rounded-2xl border border-sand-deep bg-white/80 p-6">
            <div className="flex items-baseline justify-between">
              <h3 className="font-display text-2xl">{c.symbol}</h3>
              <span className="text-xs uppercase tracking-wider text-ink-soft">estimate</span>
            </div>
            {c.impliedOpen ? (
              <>
                <p className="mt-4 text-sm text-ink-soft">Opening estimate</p>
                <p className="num text-3xl">{usd(c.impliedOpen)}</p>
                <p className={`num mt-1 text-lg ${Number(c.gap) >= 0 ? "text-forest" : "text-rose"}`}>
                  {c.gap === null ? "—" : signedPct(c.gap)} <span className="text-ink-soft">± {(Number(c.band) * 100).toFixed(1)}%</span>
                </p>
                <dl className="mt-4 grid grid-cols-3 gap-2 text-xs text-ink-soft">
                  <div>
                    <dt>Close</dt>
                    <dd className="num text-ink">{usd(c.close ?? "0")}</dd>
                  </div>
                  <div>
                    <dt>Perp now</dt>
                    <dd className="num text-ink">{usd(c.markNow ?? "0")}</dd>
                  </div>
                  <div>
                    <dt>Basis at close</dt>
                    <dd className="num text-ink">{c.basisBp} bp</dd>
                  </div>
                </dl>
              </>
            ) : (
              <p className="mt-4 text-sm text-ink-soft">No estimate: {c.error ?? "waiting for data"}.</p>
            )}
          </article>
        ))}
      </div>
      <p className="text-xs text-ink-soft">
        Updated {new Date(updated).toLocaleTimeString()} · refreshes every 15 s. The ± band is the root-mean-square error
        of this method over the last {view.calibration.closures} closures ({view.calibration.sigmaBp} bp overall).
      </p>
    </div>
  );
}

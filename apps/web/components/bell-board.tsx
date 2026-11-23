"use client";

import { useEffect, useState } from "react";
import type { BellView } from "@/lib/server/bell";

const pct = (v: string | null, dp = 2) => (v === null ? "—" : `${Number(v) >= 0 ? "+" : "−"}${Math.abs(Number(v) * 100).toFixed(dp)}%`);

export function BellBoard({ initial }: { initial: BellView }) {
  const [view, setView] = useState(initial);
  const [updated, setUpdated] = useState<string>(initial.now);

  useEffect(() => {
    const t = setInterval(async () => {
      const r = await fetch("/api/bell", { cache: "no-store" });
      if (r.ok) {
        const v = (await r.json()) as BellView;
        setView(v);
        setUpdated(v.now);
      }
    }, 15_000);
    return () => clearInterval(t);
  }, []);

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
                <p className="mt-4 text-sm text-ink-soft">Implied open</p>
                <p className="num text-3xl">${c.impliedOpen}</p>
                <p className={`num mt-1 text-lg ${Number(c.gap) >= 0 ? "text-forest" : "text-rose"}`}>
                  {pct(c.gap)} <span className="text-ink-soft">± {(Number(c.band) * 100).toFixed(1)}%</span>
                </p>
                <dl className="mt-4 grid grid-cols-3 gap-2 text-xs text-ink-soft">
                  <div>
                    <dt>Close</dt>
                    <dd className="num text-ink">${c.close}</dd>
                  </div>
                  <div>
                    <dt>Perp now</dt>
                    <dd className="num text-ink">${c.markNow}</dd>
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

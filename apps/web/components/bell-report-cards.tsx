import type { BellReportCard } from "@/lib/server/bell-reports";
import type { BellAggregate } from "@/lib/server/bell-summary";

const pct = (v: string, dp = 2) => `${Number(v) >= 0 ? "+" : "−"}${Math.abs(Number(v) * 100).toFixed(dp)}%`;
const usd = (v: string) => `${Number(v) < 0 ? "−" : ""}$${Math.abs(Number(v)).toFixed(2)}`;
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/New_York" });

export function BellAccuracy({ a }: { a: BellAggregate }) {
  if (a.reports === 0) {
    return (
      <p className="rounded-2xl bg-sand p-6 text-ink-soft">
        No Bell reports yet. A report is written 5 minutes after each open for every Shield until the bell, comparing the
        estimate with where the stock actually opened.
      </p>
    );
  }
  return (
    <dl className="grid grid-cols-3 gap-4">
      {[
        ["Reports", String(a.reports)],
        ["Mean estimate error", a.meanAbsErrorBp === null ? "—" : `${a.meanAbsErrorBp} bp`],
        ["Opened inside the ± band", a.hitRate === null ? "—" : `${(Number(a.hitRate) * 100).toFixed(0)}%`],
      ].map(([label, v]) => (
        <div key={label} className="rounded-2xl bg-sand p-5">
          <dt className="text-xs uppercase tracking-wider text-ink-soft">{label}</dt>
          <dd className="num mt-1 font-display text-3xl text-forest-deep">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function BellReportCards({ cards }: { cards: BellReportCard[] }) {
  if (cards.length === 0) {
    return <p className="rounded-2xl bg-sand p-6 text-ink-soft">You have no Bell reports yet. Shield until the bell during a closure to get one.</p>;
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {cards.map((c) => (
        <article key={c.closeAt} className="rounded-2xl border border-sand-deep bg-white/80 p-6">
          <p className="text-xs uppercase tracking-wider text-ink-soft">
            {c.kind} closure · {day(c.closeAt)} → {day(c.openAt)}
          </p>
          <ul className="mt-4 space-y-3">
            {c.legs.map((l) => (
              <li key={l.symbol}>
                <p className="font-display text-xl">{l.symbol}</p>
                <dl className="mt-1 grid grid-cols-3 gap-2 text-sm">
                  <div>
                    <dt className="text-xs text-ink-soft">Estimate</dt>
                    <dd className="num">
                      {pct(l.estGap)}
                      {l.band && <span className="text-ink-soft"> ±{(Number(l.band) * 100).toFixed(1)}%</span>}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-ink-soft">Opened</dt>
                    <dd className="num">{pct(l.realisedGap)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-ink-soft">Hedge P&amp;L</dt>
                    <dd className="num">{usd(l.hedgePnl)}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
          <dl className="mt-5 grid grid-cols-2 gap-2 border-t border-sand-deep pt-4 text-sm">
            <div>
              <dt className="text-xs text-ink-soft">Gap: estimate / actual</dt>
              <dd className="num">
                {usd(c.estGapUsd)} / {usd(c.realGapUsd)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-ink-soft">Costs (fees, funding)</dt>
              <dd className="num">{usd(c.costUsd)}</dd>
            </div>
            <div className="col-span-2">
              <dt className="text-xs text-ink-soft">Net saved by the hedge</dt>
              <dd className={`num text-lg ${Number(c.savedUsd) < 0 ? "text-rose" : "text-forest"}`}>{usd(c.savedUsd)}</dd>
            </div>
          </dl>
        </article>
      ))}
    </div>
  );
}

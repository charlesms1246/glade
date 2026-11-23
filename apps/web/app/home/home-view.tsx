"use client";

import Link from "next/link";
import { ExposureGauge } from "@/components/exposure-gauge";
import { qty, signedUsd, usd } from "@/lib/client/format";
import { usePoll } from "@/lib/client/use-poll";
import type { PortfolioView } from "@/lib/server/portfolio";

export function HomeView() {
  const { data: pf, error } = usePoll<PortfolioView>("/api/portfolio");
  if (!pf) return error ? <p className="text-rose">{error}</p> : <div className="h-64 rounded-2xl bg-sand" />;

  return (
    <div className="space-y-8">
      <section className="grid gap-4 sm:grid-cols-3">
        {[
          { label: "Equity", value: pf.equityUsd },
          { label: "Stocks", value: pf.stockValueUsd },
          { label: "Paper cash", value: pf.cashUsd },
        ].map((s) => (
          <div key={s.label} className="rounded-2xl bg-sand p-6">
            <p className="text-xs uppercase tracking-wider text-ink-soft">{s.label}</p>
            <p className="num mt-2 font-display text-3xl text-forest-deep">{usd(s.value)}</p>
          </div>
        ))}
      </section>

      <section className="rounded-2xl border border-sand-deep bg-white/70 p-7">
        <div className="flex items-baseline justify-between">
          <h2 className="font-display text-2xl text-forest-deep">Exposure</h2>
          <span className="text-xs text-ink-soft">% of stock value hedged</span>
        </div>
        <div className="mt-5">
          <ExposureGauge exposure={pf.exposure} />
        </div>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href="/shield" className="rounded-full bg-forest px-5 py-2.5 text-sm font-medium text-paper hover:bg-forest-deep">
            Shield
          </Link>
          <Link href="/bell" className="rounded-full border border-forest/30 px-5 py-2.5 text-sm font-medium text-forest hover:bg-sand">
            Bell
          </Link>
        </div>
      </section>

      <section>
        <div className="flex items-baseline justify-between">
          <h2 className="font-display text-2xl text-forest-deep">Holdings</h2>
          <Link href="/buy" className="text-sm text-forest hover:underline">
            Buy
          </Link>
        </div>
        {pf.holdings.length === 0 ? (
          <p className="mt-4 rounded-2xl bg-sand p-6 text-ink-soft">No stocks yet. Buy one to start protecting it.</p>
        ) : (
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {pf.holdings.map((h) => (
              <article key={h.symbol} className="rounded-2xl border border-sand-deep bg-white/80 p-6">
                <div className="flex items-baseline justify-between">
                  <h3 className="font-display text-2xl">{h.symbol}</h3>
                  <span className="num text-lg">{usd(h.valueUsd)}</span>
                </div>
                <ul className="num mt-3 space-y-1 text-sm text-ink-soft">
                  {h.tokens.map((t) => (
                    <li key={t.symbol} className="flex justify-between">
                      <span>
                        {qty(t.qty)} {t.symbol}
                      </span>
                      <span>{t.priceUsd ? `@ ${usd(t.priceUsd)}` : ""}</span>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        )}
      </section>

      {pf.positions.length > 0 && (
        <section>
          <h2 className="font-display text-2xl text-forest-deep">Hedges</h2>
          <div className="mt-4 overflow-x-auto rounded-2xl border border-sand-deep bg-white/80 p-6">
            <table className="num w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-ink-soft">
                <tr>
                  <th className="pb-2 font-normal">Perp</th>
                  <th className="pb-2 font-normal">Mode</th>
                  <th className="pb-2 text-right font-normal">Short</th>
                  <th className="pb-2 text-right font-normal">Notional</th>
                  <th className="pb-2 text-right font-normal">Liquidation</th>
                  <th className="pb-2 text-right font-normal">P&amp;L</th>
                </tr>
              </thead>
              <tbody>
                {pf.positions.map((p) => (
                  <tr key={p.assetId} className="border-t border-sand-deep">
                    <td className="py-2">{p.symbol}</td>
                    <td className="py-2 capitalize">{p.mode}</td>
                    <td className="py-2 text-right">{qty(p.size)}</td>
                    <td className="py-2 text-right">{usd(p.notionalUsd)}</td>
                    <td className="py-2 text-right">{p.liquidationPrice ? usd(p.liquidationPrice) : "—"}</td>
                    <td className={`py-2 text-right ${Number(p.unrealizedPnlUsd ?? 0) < 0 ? "text-rose" : ""}`}>{p.unrealizedPnlUsd ? signedUsd(p.unrealizedPnlUsd) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

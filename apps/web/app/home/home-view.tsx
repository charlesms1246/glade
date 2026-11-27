"use client";

import Link from "next/link";
import { EquityChart } from "@/components/equity-chart";
import { ExposureGauge } from "@/components/exposure-gauge";
import { isNeg, qty, signedUsd, usd } from "@/lib/client/format";
import { usePoll } from "@/lib/client/use-poll";
import type { PortfolioView } from "@/lib/server/portfolio";

export function HomeView() {
  const { data: pf, error } = usePoll<PortfolioView>("/api/portfolio");
  if (!pf) {
    return error ? (
      <p role="alert" className="rounded-2xl bg-sand p-6 text-rose">
        Could not load your portfolio: {error} It retries every few seconds.
      </p>
    ) : (
      <div className="grid gap-4 sm:grid-cols-3" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-28 animate-pulse rounded-2xl bg-sand" />
        ))}
      </div>
    );
  }
  const notFunded = pf.holdings.length === 0 && Number(pf.equityUsd) === 0;
  const hasStocks = pf.holdings.length > 0;

  return (
    <div className="space-y-8">
      {notFunded && (
        <p className="rounded-2xl border border-moss/40 bg-sand p-5 text-sm">
          Your paper account is still being set up.{" "}
          <Link href="/onboarding" className="text-forest underline">
            Check its status
          </Link>
          .
        </p>
      )}
      <section className="grid gap-4 sm:grid-cols-3">
        {[
          { label: "Equity", value: pf.equityUsd, note: "Cash, stocks, and hedge margin with its P&L" },
          { label: "Stocks", value: pf.stockValueUsd, note: "At the latest price" },
          { label: "Paper cash", value: pf.cashUsd, note: "Simulated USDC, free to use" },
        ].map((s) => (
          <div key={s.label} className="rounded-2xl bg-sand p-6">
            <p className="text-xs uppercase tracking-wider text-ink-soft">{s.label}</p>
            <p className="num mt-2 font-display text-3xl text-forest-deep">{usd(s.value)}</p>
            <p className="mt-1 text-xs text-ink-soft">{s.note}</p>
          </div>
        ))}
      </section>

      {!notFunded && (hasStocks || pf.positions.length > 0) && (
        <section className="rounded-2xl border border-sand-deep bg-white/70 p-7">
          <div className="flex items-baseline justify-between">
            <h2 className="font-display text-2xl text-forest-deep">Equity</h2>
            <span className="text-xs text-ink-soft">last 7 days</span>
          </div>
          <div className="mt-5">
            <EquityChart />
          </div>
        </section>
      )}

      <section className="rounded-2xl border border-sand-deep bg-white/70 p-7">
        <div className="flex items-baseline justify-between">
          <h2 className="font-display text-2xl text-forest-deep">Exposure</h2>
          <span className="text-xs text-ink-soft">% of stock value hedged</span>
        </div>
        {hasStocks ? (
          <>
            <div className="mt-5">
              <ExposureGauge exposure={pf.exposure} />
            </div>
            <p className="mt-4 text-sm text-ink-soft">
              Shielded: hedged by a Shield or Bell you approved. Floored: hedged by your Floor mandate. Exposed: moves fully with
              the stock.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link href="/shield" className="rounded-full bg-forest px-5 py-2.5 text-sm font-medium text-paper hover:bg-forest-deep">
                Shield
              </Link>
              <Link href="/floor" className="rounded-full border border-forest/30 px-5 py-2.5 text-sm font-medium text-forest hover:bg-sand">
                Floor
              </Link>
              <Link href="/bell" className="rounded-full border border-forest/30 px-5 py-2.5 text-sm font-medium text-forest hover:bg-sand">
                Bell
              </Link>
            </div>
          </>
        ) : (
          <p className="mt-4 text-ink-soft">Nothing to protect yet. Once you hold a stock, this shows how much of it is hedged.</p>
        )}
      </section>

      <section>
        <div className="flex items-baseline justify-between">
          <h2 className="font-display text-2xl text-forest-deep">Holdings</h2>
          <Link href="/buy" className="text-sm text-forest hover:underline">
            Buy
          </Link>
        </div>
        {pf.holdings.length === 0 ? (
          <div className="mt-4 rounded-2xl bg-sand p-6">
            <p className="text-ink-soft">No stocks yet. Tokenized US stocks trade around the clock here, at live prices.</p>
            <Link href="/buy" className="mt-4 inline-block rounded-full bg-forest px-5 py-2.5 text-sm font-medium text-paper hover:bg-forest-deep">
              Buy your first stock
            </Link>
          </div>
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
                    <td className={`py-2 text-right ${isNeg(p.unrealizedPnlUsd) ? "text-rose" : ""}`}>{p.unrealizedPnlUsd ? signedUsd(p.unrealizedPnlUsd) : "—"}</td>
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

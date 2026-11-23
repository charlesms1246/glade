import { pct, qty, signedUsd, usd } from "@/lib/client/format";
import type { ShieldPlan } from "@/lib/server/shield";

export function ShieldPlanView({ plan }: { plan: ShieldPlan }) {
  const t = plan.totals;
  return (
    <div className="space-y-6">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-ink-soft">
            <tr>
              <th className="py-2 font-normal">Holding</th>
              <th className="py-2 font-normal">Hedge with</th>
              <th className="py-2 text-right font-normal">Short size</th>
              <th className="py-2 text-right font-normal">Notional</th>
              <th className="py-2 text-right font-normal">Margin</th>
              <th className="py-2 text-right font-normal">Liquidation (estimate)</th>
            </tr>
          </thead>
          <tbody>
            {plan.rows.map((r) => (
              <tr key={r.symbol} className={`border-t border-sand-deep ${r.rejected ? "text-ink-soft line-through" : ""}`}>
                <td className="py-2.5">
                  {r.symbol} <span className="num text-ink-soft">{usd(r.valueUsd)}</span>
                </td>
                <td className="py-2.5">
                  {r.perpSymbol} perp
                  {r.method === "index" && (
                    <span className="ml-1 text-xs text-ink-soft">(index, β {r.beta}{r.lowConfidence ? ", low confidence" : ""})</span>
                  )}
                </td>
                <td className="num py-2.5 text-right">{qty(r.qty)}</td>
                <td className="num py-2.5 text-right">{usd(r.notionalUsd)}</td>
                <td className="num py-2.5 text-right">{usd(r.marginUsd)}</td>
                <td className="num py-2.5 text-right">{usd(r.liquidationEstimate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {plan.unhedgeable.length > 0 && <p className="text-sm text-ink-soft">No perp available for: {plan.unhedgeable.join(", ")}.</p>}

      <div className="rounded-xl bg-paper p-5">
        <h3 className="text-xs uppercase tracking-wider text-ink-soft">Costs</h3>
        <dl className="mt-3 grid grid-cols-2 gap-y-2 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-ink-soft">Trading fees</dt>
            <dd className="num">{usd(t.feesUsd, 4)}</dd>
          </div>
          <div>
            <dt className="text-ink-soft">Funding per day</dt>
            <dd className="num">{signedUsd(t.fundingPerDayUsd, 4)}</dd>
          </div>
          <div>
            <dt className="text-ink-soft">Margin set aside</dt>
            <dd className="num">{usd(t.marginUsd)}</dd>
          </div>
          <div>
            <dt className="text-ink-soft">Leverage</dt>
            <dd className="num">{plan.leverage}×</dd>
          </div>
        </dl>
        <p className="mt-3 text-xs leading-relaxed text-ink-soft">
          Fees are {plan.kind === "bell" ? "for opening and for the automatic unwind" : "for opening; closing costs about the same"}.
          Funding is an estimate at the current hourly rate and can change every hour; a positive amount means you receive it.
          Margin comes back when the hedge closes, plus or minus its P&amp;L. Margin plus a 10% buffer ({usd(t.requiredUsdc)}) must be
          free in paper cash ({usd(plan.cashUsd)}). Per-order limit: {usd(plan.maxOrderUsd)}.
        </p>
      </div>
      {plan.rows.some((r) => r.method === "index") && (
        <p className="text-xs text-ink-soft">
          An index hedge uses a market-wide perp because the stock has no perp of its own. It follows the market, not the stock
          exactly, so the hedge can gain or lose differently from the stock.
        </p>
      )}

      <div>
        <h3 className="text-xs uppercase tracking-wider text-ink-soft">If the stocks move (estimate)</h3>
        <div className="mt-2 grid grid-cols-3 gap-3">
          {plan.scenarios.map((s) => (
            <div key={s.shock} className="rounded-xl bg-paper p-4">
              <p className="font-medium">{Number(s.shock) > 0 ? "+" : ""}{pct(s.shock)}</p>
              <p className="mt-2 text-xs text-ink-soft">Stocks <span className="num">{signedUsd(s.spotUsd)}</span></p>
              <p className="text-xs text-ink-soft">Hedge <span className="num">{signedUsd(s.hedgeUsd)}</span></p>
              <p className={`mt-1 text-sm ${Number(s.netUsd) < 0 ? "text-rose" : "text-forest"}`}>Net <span className="num">{signedUsd(s.netUsd)}</span></p>
            </div>
          ))}
        </div>
      </div>
      {plan.reasons.length > 0 && (
        <ul className="space-y-1 text-sm text-rose">
          {plan.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

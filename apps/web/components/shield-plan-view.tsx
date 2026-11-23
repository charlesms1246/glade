import { pct, qty, signedUsd, usd } from "@/lib/client/format";
import type { ShieldPlan } from "@/lib/server/shield";

export function ShieldPlanView({ plan }: { plan: ShieldPlan }) {
  const t = plan.totals;
  return (
    <div className="space-y-6">
      <div className="overflow-x-auto">
        <table className="num w-full text-sm">
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
                  {r.symbol} <span className="text-ink-soft">{usd(r.valueUsd)}</span>
                </td>
                <td className="py-2.5">
                  {r.perpSymbol} perp
                  {r.method === "index" && (
                    <span className="ml-1 text-xs text-ink-soft">(index, β {r.beta}{r.lowConfidence ? ", low confidence" : ""})</span>
                  )}
                </td>
                <td className="py-2.5 text-right">{qty(r.qty)}</td>
                <td className="py-2.5 text-right">{usd(r.notionalUsd)}</td>
                <td className="py-2.5 text-right">{usd(r.marginUsd)}</td>
                <td className="py-2.5 text-right">{usd(r.liquidationEstimate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {plan.unhedgeable.length > 0 && <p className="text-sm text-ink-soft">No perp available for: {plan.unhedgeable.join(", ")}.</p>}

      <dl className="num grid grid-cols-2 gap-y-2 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-ink-soft">Margin posted</dt>
          <dd>{usd(t.marginUsd)}</dd>
        </div>
        <div>
          <dt className="text-ink-soft">Fees</dt>
          <dd>{usd(t.feesUsd, 4)}</dd>
        </div>
        <div>
          <dt className="text-ink-soft">Funding per day</dt>
          <dd>{signedUsd(t.fundingPerDayUsd, 4)}</dd>
        </div>
        <div>
          <dt className="text-ink-soft">Leverage</dt>
          <dd>{plan.leverage}×</dd>
        </div>
      </dl>
      <p className="text-xs text-ink-soft">
        Funding is paid or received every hour at the live rate; positive means you receive. Margin plus a 10% buffer (
        {usd(t.requiredUsdc)}) must be free in paper cash ({usd(plan.cashUsd)}).
      </p>

      <div>
        <h3 className="text-xs uppercase tracking-wider text-ink-soft">If the stocks move (estimate)</h3>
        <div className="mt-2 grid grid-cols-3 gap-3">
          {plan.scenarios.map((s) => (
            <div key={s.shock} className="rounded-xl bg-paper p-4">
              <p className="font-medium">{Number(s.shock) > 0 ? "+" : ""}{pct(s.shock)}</p>
              <p className="num mt-2 text-xs text-ink-soft">Stocks {signedUsd(s.spotUsd)}</p>
              <p className="num text-xs text-ink-soft">Hedge {signedUsd(s.hedgeUsd)}</p>
              <p className={`num mt-1 text-sm ${Number(s.netUsd) < 0 ? "text-rose" : "text-forest"}`}>Net {signedUsd(s.netUsd)}</p>
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

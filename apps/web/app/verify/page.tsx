const live = [
  ["GET /v1/defi/market/prices", "spot and perp (asset_class=perp) prices", "live"],
  ["GET /v1/defi/market/prices/history", "1m–1d history with as_of, for Bell snapshots, calibration and replay", "live"],
  ["GET /v1/defi/market/market-data/perp/history", "hourly perp funding for replay costs", "live"],
  ["wss /v1/defi/market", "price.{SYMBOL} and price.{SYMBOL}-PERP ticks", "live"],
  ["GET /v1/gateway/assets", "stock and perp catalog, max leverage, funding", "live"],
  ["POST /v1/auth/api-key/token", "org token (ES256 challenge), cached, re-minted at 55 min", "built"],
  ["POST /v1/account/organizations/{org}/users", "one Gateway user per Glade user, per-user signer key", "built"],
  ["POST /v1/gateway/orders → /execute", "perp hedges: short sell, reduce-only buy; Turnkey P-256 stamps", "built"],
  ["GET /v1/gateway/portfolio, /positions, /orders/{id}", "holdings, liquidation price, fills", "built"],
] as const;

const code = [
  ["packages/tm-client", "the only code that calls True Markets"],
  ["packages/stamp", "challenge signing, payload stamps, signer-key encryption"],
  ["packages/engine", "pure sizing, CPPI, Bell, guards, mandate policy"],
  ["packages/calendar", "NYSE sessions, holidays, early closes"],
  ["apps/worker", "executor, market stream, Bell scheduler"],
  ["scripts/replay.ts, bell-calibrate.ts", "evidence from live public data"],
] as const;

export default function VerifyPage() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-16">
      <h1 className="font-display text-4xl tracking-tight text-forest-deep">How to verify the Gateway integration</h1>
      <p className="mt-3 max-w-2xl text-ink-soft">
        Every True Markets call goes through one typed client generated from the published OpenAPI specs. &ldquo;Live&rdquo;
        means this deployment is calling it now; &ldquo;built&rdquo; means implemented and tested against a fake server,
        waiting for the organization key. Order ids with explorer links will appear here once live.
      </p>
      <table className="mt-10 w-full text-left text-sm">
        <thead className="text-xs uppercase tracking-wider text-ink-soft">
          <tr>
            <th className="py-2 pr-4">Endpoint</th>
            <th className="py-2 pr-4">Used for</th>
            <th className="py-2">Status</th>
          </tr>
        </thead>
        <tbody>
          {live.map(([ep, use, status]) => (
            <tr key={ep} className="border-t border-sand-deep/70">
              <td className="num py-3 pr-4 text-xs">{ep}</td>
              <td className="py-3 pr-4 text-ink-soft">{use}</td>
              <td className="py-3">
                <span className={`rounded-full px-2 py-0.5 text-xs ${status === "live" ? "bg-forest text-paper" : "bg-sand text-ink"}`}>
                  {status}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2 className="mt-14 font-display text-2xl">Code map</h2>
      <ul className="mt-4 space-y-2 text-sm">
        {code.map(([path, what]) => (
          <li key={path}>
            <span className="num text-xs">{path}</span> <span className="text-ink-soft">· {what}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

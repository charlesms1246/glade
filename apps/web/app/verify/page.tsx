import { connection } from "next/server";
import { Suspense } from "react";
import { apiCallStats, recentOrders, verifyStats } from "@/lib/server/verify";

const REPO = "https://github.com/charlesms1246/glade/blob/main";

const endpoints = [
  ["GET /v1/defi/market/prices", "spot and perp prices for plans, fills and Bell", "live"],
  ["GET /v1/defi/market/prices/history", "1m–1d history with as_of: Bell snapshots, calibration, replay, reports", "live"],
  ["GET /v1/defi/market/market-data/perp/history", "hourly perp funding for replay costs", "live"],
  ["wss /v1/defi/market", "price ticks that feed the paper venue and Floor", "live"],
  ["GET /v1/gateway/assets", "stock and perp catalog, max leverage, hourly funding", "live"],
  ["POST /v1/auth/api-key/token", "org token (ES256 challenge), cached, re-minted at 55 min", "live"],
  ["POST /v1/account/organizations/{org}/users", "a Gateway user per Glade user, each with its own signer key", "live"],
  ["POST /v1/gateway/orders → /execute", "hedge and buy orders, stamped with the user's P-256 signer", "paper"],
  ["GET /v1/gateway/portfolio, /positions, /orders/{id}", "holdings, positions, liquidation price, fills", "paper"],
] as const;

const guards = [
  ["packages/tm-client/src/money-guard.ts", "throws on any production write except token, user creation and quotes, before any request is sent"],
  ["apps/worker/src/executor/guard.ts", "the executor runs only against the paper venue; production orders are refused"],
  ["packages/engine/src/mandate.ts", "signing policy: short or reduce-only perps only, no transfers, caps"],
  ["apps/worker/src/policy/authorize.ts", "every order needs a verified passkey approval of that leg, or an authentic signed mandate"],
  ["packages/paper/src/venue.ts", "paper venue: same API shapes, verifies each stamp, fills at live prices"],
] as const;

const evidence = [
  ["replay-NVDA-90d-f0.85.json", "Floor replayed hourly on 90 days of NVDA prices"],
  ["replay-NVDA-30d-f0.85.json", "the same over 30 days"],
  ["replay-NVDA-30d-f0.9-ratchet.json", "30 days with a 90% ratcheting target"],
  ["bell-calibration-NVDA.json", "Bell estimate error measured on past closures"],
] as const;

const STATUS_TEXT: Record<string, string> = { done: "filled", failed: "failed", rejected: "refused by policy", pending: "queued", executing: "in progress" };

function Badge({ s }: { s: string }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs ${s === "live" ? "bg-forest text-paper" : "bg-moss/20 text-forest"}`}>{s}</span>;
}

const classes = ["2xx", "4xx", "5xx"] as const;

async function Evidence() {
  await connection();
  const [orders, api] = await Promise.all([recentOrders(), apiCallStats()]);
  const split = (o: Record<string, number>) => classes.map((c) => `${o[c] ?? 0}`).join(" / ");
  return (
    <>
      <h2 className="mt-12 font-display text-2xl">Recent orders</h2>
      <p className="mt-2 text-sm text-ink-soft">
        The last 20 orders across all users, anonymous. Paper fills on live True Markets prices (no real money), so there is no
        on-chain explorer link.
      </p>
      {orders.length === 0 ? (
        <p className="mt-4 rounded-2xl bg-sand p-5 text-ink-soft">No orders yet.</p>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-2xl border border-sand-deep bg-white/80 p-5">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wider text-ink-soft">
              <tr>
                <th className="pb-2 pr-4 font-normal">Time (UTC)</th>
                <th className="pb-2 pr-4 font-normal">Symbol</th>
                <th className="pb-2 pr-4 font-normal">Side</th>
                <th className="pb-2 pr-4 text-right font-normal">Qty</th>
                <th className="pb-2 pr-4 text-right font-normal">Fill price</th>
                <th className="pb-2 pr-4 font-normal">Status</th>
                <th className="pb-2 pr-4 font-normal">Reduce-only</th>
                <th className="pb-2 font-normal">Source</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((r, i) => (
                <tr key={`${r.at}-${i}`} className="border-t border-sand-deep">
                  <td className="num py-2 pr-4 text-xs">{r.at.slice(0, 19).replace("T", " ")}</td>
                  <td className="py-2 pr-4">{r.symbol}</td>
                  <td className="py-2 pr-4">{r.side}</td>
                  <td className="num py-2 pr-4 text-right">{r.qty}</td>
                  <td className="num py-2 pr-4 text-right">{r.price ? `$${Number(r.price).toFixed(2)}` : "—"}</td>
                  <td className="py-2 pr-4">{r.status}</td>
                  <td className="py-2 pr-4">{r.reduceOnly ? "yes" : "no"}</td>
                  <td className="py-2">{r.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 className="mt-12 font-display text-2xl">True Markets API calls</h2>
      <p className="mt-2 text-sm text-ink-soft">
        Environment: <strong className="text-ink">{api.env === "prod" ? "production, read-only" : "UAT, paper funds"}</strong>.
        Calls made by the Glade worker, counted by endpoint (no ids, queries or payloads are stored). Today (UTC):{" "}
        <span className="num">{api.todayTotal}</span> · since launch: <span className="num">{api.total}</span>. Columns show
        2xx / 4xx / 5xx.
      </p>
      {api.rows.length === 0 ? (
        <p className="mt-4 rounded-2xl bg-sand p-5 text-ink-soft">No calls recorded yet.</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wider text-ink-soft">
              <tr>
                <th className="py-2 pr-4 font-normal">Endpoint</th>
                <th className="py-2 pr-4 text-right font-normal">Today</th>
                <th className="py-2 text-right font-normal">Since launch</th>
              </tr>
            </thead>
            <tbody>
              {api.rows.map((r) => (
                <tr key={`${r.method} ${r.route}`} className="border-t border-sand-deep/70">
                  <td className="num py-2 pr-4 text-xs">
                    {r.method} {r.route}
                  </td>
                  <td className="num py-2 pr-4 text-right text-xs">{split(r.today)}</td>
                  <td className="num py-2 text-right text-xs">{split(r.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

async function Live() {
  await connection();
  const v = await verifyStats();
  const intents = Object.entries(v.intents).sort((a, b) => b[1] - a[1]);
  return (
    <>
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          ["Gateway users linked", v.gatewayUsers],
          ["Paper accounts", v.paperAccounts],
          ["Paper orders filled", v.completedOrders],
          ["Approved orders", Object.values(v.intents).reduce((a, b) => a + b, 0)],
        ].map(([label, n]) => (
          <div key={label} className="rounded-2xl bg-sand p-5">
            <dt className="text-xs uppercase tracking-wider text-ink-soft">{label}</dt>
            <dd className="num mt-1 font-display text-3xl text-forest-deep">{n}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-sm text-ink-soft">
        Orders by outcome: {intents.map(([s, n]) => `${n} ${STATUS_TEXT[s] ?? s}`).join(" · ") || "none yet"}.
      </p>

      <h2 className="mt-12 font-display text-2xl">Last 10 paper fills</h2>
      {v.recent.length === 0 ? (
        <p className="mt-4 rounded-2xl bg-sand p-5 text-ink-soft">No fills yet.</p>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-2xl border border-sand-deep bg-white/80 p-5">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wider text-ink-soft">
              <tr>
                <th className="pb-2 pr-4 font-normal">Time (UTC)</th>
                <th className="pb-2 pr-4 font-normal">Mode</th>
                <th className="pb-2 pr-4 font-normal">Order</th>
                <th className="pb-2 pr-4 text-right font-normal">Qty</th>
                <th className="pb-2 pr-4 text-right font-normal">Price</th>
                <th className="pb-2 text-right font-normal">Fee</th>
              </tr>
            </thead>
            <tbody>
              {v.recent.map((r) => (
                <tr key={`${r.at}-${r.symbol}-${r.qty}`} className="border-t border-sand-deep">
                  <td className="num py-2 pr-4 text-xs">{r.at.slice(0, 19).replace("T", " ")}</td>
                  <td className="py-2 pr-4">{r.mode}</td>
                  <td className="py-2 pr-4">
                    {r.side} {r.symbol} {r.instrument}
                  </td>
                  <td className="num py-2 pr-4 text-right">{r.qty}</td>
                  <td className="num py-2 pr-4 text-right">{r.price ? `$${Number(r.price).toFixed(2)}` : "—"}</td>
                  <td className="num py-2 text-right">{r.fee ? `$${Number(r.fee).toFixed(4)}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export default function VerifyPage() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-16">
      <h1 className="font-display text-4xl tracking-tight text-forest-deep">Verify</h1>
      <p className="mt-3 max-w-3xl text-ink-soft">
        Market data comes live from True Markets production. Execution runs on a paper venue that mirrors the Gateway order
        API and fills at those live prices: <strong className="text-ink">no real money</strong>. Production orders are
        refused in code, at every layer listed below.
      </p>

      <section className="mt-10">
        <Suspense fallback={<div className="h-28 animate-pulse rounded-2xl bg-sand" />}>
          <Live />
        </Suspense>
      </section>

      <Suspense fallback={<div className="mt-12 h-28 animate-pulse rounded-2xl bg-sand" />}>
        <Evidence />
      </Suspense>

      <h2 className="mt-14 font-display text-2xl">True Markets endpoints</h2>
      <p className="mt-2 text-sm text-ink-soft">
        All calls go through one typed client generated from the published OpenAPI specs. &ldquo;Live&rdquo;: called against True
        Markets now. &ldquo;Paper&rdquo;: the same request and response shapes, served by the paper venue.
      </p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wider text-ink-soft">
            <tr>
              <th className="py-2 pr-4 font-normal">Endpoint</th>
              <th className="py-2 pr-4 font-normal">Used for</th>
              <th className="py-2 font-normal">Status</th>
            </tr>
          </thead>
          <tbody>
            {endpoints.map(([ep, use, s]) => (
              <tr key={ep} className="border-t border-sand-deep/70">
                <td className="num py-3 pr-4 text-xs">{ep}</td>
                <td className="py-3 pr-4 text-ink-soft">{use}</td>
                <td className="py-3">
                  <Badge s={s} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mt-14 font-display text-2xl">Where real money is refused</h2>
      <ul className="mt-4 space-y-2 text-sm">
        {guards.map(([path, what]) => (
          <li key={path}>
            <a href={`${REPO}/${path}`} className="num text-xs text-forest underline" target="_blank" rel="noreferrer">
              {path}
            </a>{" "}
            <span className="text-ink-soft">· {what}</span>
          </li>
        ))}
      </ul>

      <h2 className="mt-14 font-display text-2xl">Evidence from live market data</h2>
      <ul className="mt-4 space-y-2 text-sm">
        {evidence.map(([file, what]) => (
          <li key={file}>
            <a href={`/evidence/${file}`} className="num text-xs text-forest underline">
              {file}
            </a>{" "}
            <span className="text-ink-soft">· {what}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

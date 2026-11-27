import { usd } from "@/lib/client/format";
import d30 from "../../../../docs/evidence/replay-NVDA-30d-f0.85.json";
import d90 from "../../../../docs/evidence/replay-NVDA-90d-f0.85.json";

type Replay = typeof d90;

function Chart({ data }: { data: Replay }) {
  const s = data.series;
  const W = 900;
  const H = 280;
  const ys = s.flatMap((p) => [Number(p.equity), Number(p.unhedged), Number(p.floor)]);
  const min = Math.min(...ys) * 0.98;
  const max = Math.max(...ys) * 1.02;
  const x = (i: number) => (i / (s.length - 1)) * W;
  const y = (v: string) => H - ((Number(v) - min) / (max - min)) * H;
  const path = (k: "equity" | "unhedged" | "floor") => s.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`).join("");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Hedged equity, unhedged value and floor over time">
      <path d={path("floor")} fill="none" stroke="var(--rose)" strokeDasharray="6 5" strokeWidth="1.5" />
      <path d={path("unhedged")} fill="none" stroke="var(--ink-soft)" strokeOpacity="0.5" strokeWidth="1.5" />
      <path d={path("equity")} fill="none" stroke="var(--forest)" strokeWidth="2.5" />
    </svg>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-ink-soft">{label}</dt>
      <dd className="num text-lg">{value}</dd>
    </div>
  );
}

function Panel({ data, title }: { data: Replay; title: string }) {
  const r = data.summary.result;
  return (
    <section className="rounded-2xl border border-sand-deep bg-white/80 p-6">
      <h2 className="font-display text-2xl">{title}</h2>
      <p className="mt-1 text-xs text-ink-soft">
        {data.summary.window.from.slice(0, 10)} → {data.summary.window.to.slice(0, 10)} · {data.summary.window.hours} hourly
        steps · target {Number(data.summary.params.floorPct) * 100}% of {usd(data.summary.params.start)}
      </p>
      <div className="mt-6">
        <Chart data={data} />
      </div>
      <div className="mt-3 flex gap-5 text-xs text-ink-soft">
        <span className="text-forest">━ With Floor</span>
        <span>━ Unhedged</span>
        <span className="text-rose">┅ Target</span>
      </div>
      <dl className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Lowest, with Floor" value={usd(r.minEquity)} />
        <Stat label="Lowest, unhedged" value={usd(r.minUnhedged)} />
        <Stat label="Final, with Floor" value={usd(r.finalEquity)} />
        <Stat label="Final, unhedged" value={usd(r.finalUnhedged)} />
        <Stat label="Hedge trades" value={String(r.trades)} />
        <Stat label="Fees (estimated)" value={usd(r.feesUsd)} />
        <Stat label="Funding received" value={usd(r.fundingNetUsd)} />
        <Stat label="Hours below target" value={String(r.floorBreaches)} />
      </dl>
    </section>
  );
}

export default function ReplayPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-8 px-6 py-16">
      <div>
        <h1 className="font-display text-4xl tracking-tight text-forest-deep">Floor, replayed on real prices</h1>
        <p className="mt-3 max-w-2xl text-ink-soft">
          The same engine that runs Floor, stepped hour by hour over True Markets price history for NVDA, hedging with the
          NVDA perpetual. Fees are estimated at 4.5 bp per trade; funding uses the perp&apos;s recorded hourly rates. The
          target can be breached between hourly rebalances when prices gap.
        </p>
      </div>
      <Panel data={d90} title="Last 90 days" />
      <Panel data={d30} title="Last 30 days" />
    </div>
  );
}

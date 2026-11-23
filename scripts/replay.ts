// Replays the Floor (CPPI) engine over real True Markets price history. Public data only; no orders.
//   pnpm replay -- --symbol NVDA --days 30 [--hedge NVDA] [--floor 0.85] [--m 4] [--ratchet] [--start 1000]
import { mkdirSync, writeFileSync } from "node:fs";
import { CPPI_DEFAULTS, cppiStep, type CppiState } from "@glade/engine";
import { dec, Decimal, fmtPct, fmtUsd, TM_BASE_URLS } from "@glade/shared";
import { createTmClient, type PricePoint } from "@glade/tm-client";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : "true";
}

const symbol = arg("symbol", "NVDA")!;
const hedgeSymbol = arg("hedge", symbol)!;
const days = Number(arg("days", "30"));
const floorPct = arg("floor", CPPI_DEFAULTS.floorPct.toString())!;
const multiplier = arg("m", CPPI_DEFAULTS.multiplier.toString())!;
const ratchet = arg("ratchet") === "true";
const start = dec(arg("start", "1000")!);
// Perp taker fee per trade, as a fraction of notional. Assumed until measured on real fills.
const feeRate = dec(arg("fee", "0.00045")!);
const env = (arg("env", "prod") as "prod" | "uat");

const tm = createTmClient({ restBase: TM_BASE_URLS[env].rest });
const window = days <= 31 ? `${days}d` : `${Math.ceil(days / 30)}M`;

const [spot, perp, funding] = await Promise.all([
  tm.priceHistory({ symbol, window, resolution: "1h" }),
  tm.priceHistory({ symbol: hedgeSymbol, window, resolution: "1h", assetClass: "perp" }),
  tm.perpHistory({ symbol: hedgeSymbol, window, resolution: "1h" }),
]);

const byT = (pts: PricePoint[] | undefined) => new Map((pts ?? []).map((p) => [p.t, dec(p.price)]));
const spotPx = byT(spot.points);
const perpPx = byT(perp.points);
const fundingByT = new Map((funding.points ?? []).filter((p) => p.funding_rate).map((p) => [p.t, dec(p.funding_rate!)]));
const times = [...spotPx.keys()].filter((t) => perpPx.has(t)).sort();
if (times.length < 24) throw new Error(`not enough aligned points (${times.length}) for ${symbol}/${hedgeSymbol}`);

const params = {
  base: start,
  floorPct,
  multiplier,
  ratchet,
  band: CPPI_DEFAULTS.band,
  minNotionalUsd: "10",
  cooldownSec: CPPI_DEFAULTS.cooldownSec,
  maxTradesDay: 24,
};

const shares = start.div(spotPx.get(times[0]!)!);
let cash = new Decimal(0); // realised hedge P&L, fees and funding
let hedgeQty = new Decimal(0); // short perp size (base units)
let entryPx = new Decimal(0);
let state: CppiState = { peak: null, lastTradeAt: null, tradesToday: 0 };
let day = "";
let trades = 0;
let fees = new Decimal(0);
let fundingNet = new Decimal(0);
let breaches = 0;
let minCushion = new Decimal(1);
let maxHedgeRatio = new Decimal(0);
const series: { t: string; equity: string; unhedged: string; floor: string; hedgeRatio: string }[] = [];

for (const t of times) {
  const s = spotPx.get(t)!;
  const p = perpPx.get(t)!;
  const now = new Date(t);
  if (t.slice(0, 10) !== day) {
    day = t.slice(0, 10);
    state = { ...state, tradesToday: 0 };
  }
  // Funding is hourly; positive means shorts receive.
  const rate = fundingByT.get(t);
  if (rate && hedgeQty.gt(0)) {
    const f = hedgeQty.mul(p).mul(rate);
    cash = cash.plus(f);
    fundingNet = fundingNet.plus(f);
  }
  const stockValue = shares.mul(s);
  const unrealised = entryPx.minus(p).mul(hedgeQty);
  const equity = stockValue.plus(cash).plus(unrealised);
  const hedgeNow = hedgeQty.mul(p);

  const r = cppiStep(state, { equity, riskyValue: stockValue, hedgeNow, legs: [{ key: hedgeSymbol, beta: 1, value: stockValue }] }, params, now);
  state = { ...state, peak: r.peak };
  if (equity.lt(r.floor)) breaches++;
  minCushion = Decimal.min(minCushion, r.cushionRatio);

  if (r.trade) {
    // Realise the old hedge at p, then hold the new target size at entry p.
    cash = cash.plus(unrealised);
    const newQty = r.hedgeTarget.div(p);
    const fee = newQty.minus(hedgeQty).abs().mul(p).mul(feeRate);
    cash = cash.minus(fee);
    fees = fees.plus(fee);
    hedgeQty = newQty;
    entryPx = p;
    trades++;
    state = { ...state, lastTradeAt: now, tradesToday: state.tradesToday + 1 };
  }
  const ratio = stockValue.gt(0) ? hedgeQty.mul(p).div(stockValue) : new Decimal(0);
  maxHedgeRatio = Decimal.max(maxHedgeRatio, ratio);
  series.push({ t, equity: equity.toFixed(2), unhedged: stockValue.toFixed(2), floor: r.floor.toFixed(2), hedgeRatio: ratio.toFixed(3) });
}

const last = series.at(-1)!;
const unhedgedMin = series.reduce((m, x) => Decimal.min(m, dec(x.unhedged)), start);
const hedgedMin = series.reduce((m, x) => Decimal.min(m, dec(x.equity)), start);
const summary = {
  generatedAt: new Date().toISOString(),
  source: `${TM_BASE_URLS[env].rest} /v1/defi/market/prices/history (1h) + perp funding history`,
  symbol,
  hedge: `${hedgeSymbol} perp`,
  window: { from: times[0], to: times.at(-1), hours: times.length },
  params: { start: start.toString(), floorPct, multiplier, ratchet, band: params.band.toString(), feeRate: feeRate.toString() },
  result: {
    finalEquity: last.equity,
    finalUnhedged: last.unhedged,
    floor: last.floor,
    floorBreaches: breaches,
    minEquity: hedgedMin.toFixed(2),
    minUnhedged: unhedgedMin.toFixed(2),
    minCushionRatio: minCushion.toFixed(4),
    maxHedgeRatio: maxHedgeRatio.toFixed(3),
    trades,
    feesUsd: fees.toFixed(4),
    fundingNetUsd: fundingNet.toFixed(4),
    upsideCapture: dec(last.unhedged).gt(start)
      ? dec(last.equity).minus(start).div(dec(last.unhedged).minus(start)).toFixed(3)
      : null,
  },
};

mkdirSync("docs/evidence", { recursive: true });
const out = `docs/evidence/replay-${symbol}-${days}d-f${floorPct}${ratchet ? "-ratchet" : ""}.json`;
writeFileSync(out, JSON.stringify({ summary, series }, null, 2) + "\n");

const R = summary.result;
console.log(`${symbol} hedged with ${hedgeSymbol} perp · ${times.length} hourly steps (${times[0]} → ${times.at(-1)})`);
console.log(`floor ${fmtPct(floorPct, 0)} of ${fmtUsd(start)}${ratchet ? " (ratchet)" : ""}, m=${multiplier}`);
console.log(`final   hedged ${fmtUsd(R.finalEquity)}  unhedged ${fmtUsd(R.finalUnhedged)}`);
console.log(`lowest  hedged ${fmtUsd(R.minEquity)}  unhedged ${fmtUsd(R.minUnhedged)}  floor ${fmtUsd(R.floor)}`);
console.log(`breaches ${R.floorBreaches} · trades ${R.trades} · fees ${fmtUsd(R.feesUsd, 4)} · funding ${fmtUsd(R.fundingNetUsd, 4)} · max hedge ${fmtPct(R.maxHedgeRatio, 1)}`);
console.log(`wrote ${out}`);

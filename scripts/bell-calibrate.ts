// Calibrates the Bell implied-open estimate on past market closures. Public data only; no orders.
// For each closure: basis at the close, implied open from the perp one hour before the open,
// compared with the spot price five minutes after the open.
//   pnpm exec tsx scripts/bell-calibrate.ts --symbol NVDA --closures 12
import { mkdirSync, writeFileSync } from "node:fs";
import { currentClosure, sessionFor, type Closure } from "@glade/calendar";
import { calibrateSigma, closeSnapshot, impliedOpen, SEED_SIGMA } from "@glade/engine";
import { dec, Decimal, TM_BASE_URLS } from "@glade/shared";
import { createTmClient } from "@glade/tm-client";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}
const symbol = arg("symbol", "NVDA");
const wanted = Number(arg("closures", "12"));
const LEAD_MS = 60 * 60_000; // estimate taken one hour before the open
const OPEN_OFFSET_MS = 5 * 60_000; // "open" price read five minutes after the bell

const tm = createTmClient({ restBase: TM_BASE_URLS.prod.rest });
const now = new Date();

/** Last 1-minute price strictly before `at`. */
async function priceBefore(at: Date, assetClass: "spot" | "perp"): Promise<Decimal | null> {
  const r = await tm.priceHistory({
    symbol,
    window: "15m",
    resolution: "1m",
    asOf: at.toISOString(),
    ...(assetClass === "perp" ? { assetClass } : {}),
  });
  const p = r.points?.at(-1);
  return p ? dec(p.price) : null;
}

function pastClosures(n: number): Closure[] {
  const out: Closure[] = [];
  for (let d = 0; d < 60 && out.length < n; d++) {
    const ymd = new Date(now.getTime() - d * 86_400_000).toISOString().slice(0, 10);
    const s = sessionFor(ymd);
    if (!s) continue;
    const c = currentClosure(new Date(s.close.getTime() + 1));
    if (c && c.openAt.getTime() + OPEN_OFFSET_MS < now.getTime()) out.push(c);
  }
  return out;
}

type Base = { kind: string; closeAt: string; openAt: string };
type Ok = Base & { close: string; basisBp: string; impliedOpen: string; actualOpen: string; estGapBp: string; realGapBp: string; errorBp: string; naiveErrorBp: string };
type Skip = Base & { skipped: string };
const rows: (Ok | Skip)[] = [];
for (const c of pastClosures(wanted)) {
  try {
    const [close, markAtClose, markLate, open] = await Promise.all([
      priceBefore(c.closeAt, "spot"),
      priceBefore(c.closeAt, "perp"),
      priceBefore(new Date(c.openAt.getTime() - LEAD_MS), "perp"),
      priceBefore(new Date(c.openAt.getTime() + OPEN_OFFSET_MS + 60_000), "spot"),
    ]);
    if (!close || !markAtClose || !markLate || !open) throw new Error("missing price data");
    const snap = closeSnapshot(close, markAtClose);
    const implied = impliedOpen(markLate, snap.basis);
    const estGap = implied.div(close).minus(1);
    const realGap = open.div(close).minus(1);
    const error = implied.div(open).minus(1);
    rows.push({
      kind: c.kind,
      closeAt: c.closeAt.toISOString(),
      openAt: c.openAt.toISOString(),
      close: close.toFixed(4),
      basisBp: snap.basis.mul(10_000).toFixed(1),
      impliedOpen: implied.toFixed(4),
      actualOpen: open.toFixed(4),
      estGapBp: estGap.mul(10_000).toFixed(1),
      realGapBp: realGap.mul(10_000).toFixed(1),
      errorBp: error.mul(10_000).toFixed(1),
      naiveErrorBp: close.div(open).minus(1).mul(10_000).toFixed(1),
    });
  } catch (e) {
    rows.push({ kind: c.kind, closeAt: c.closeAt.toISOString(), openAt: c.openAt.toISOString(), skipped: String(e).slice(0, 120) });
  }
}

const ok = rows.filter((r): r is Ok => "errorBp" in r);
const rms = (xs: Decimal[]) => (xs.length ? calibrateSigma(xs) : SEED_SIGMA);
const sigma = rms(ok.map((r) => dec(r.errorBp).div(10_000)));
const naive = rms(ok.map((r) => dec(r.naiveErrorBp).div(10_000)));
const byKind = Object.fromEntries(
  ["overnight", "weekend", "holiday"].map((k) => {
    const xs = ok.filter((r) => r.kind === k).map((r) => dec(r.errorBp).div(10_000));
    return [k, { n: xs.length, rmsErrorBp: xs.length ? calibrateSigma(xs).mul(10_000).toFixed(1) : null }];
  }),
);

const summary = {
  generatedAt: now.toISOString(),
  source: `${TM_BASE_URLS.prod.rest} /v1/defi/market/prices/history (1m, as_of)`,
  symbol,
  method: "implied open = perp mark 1h before open / (1 + basis at close); actual = spot 5 min after open",
  closures: rows.length,
  used: ok.length,
  sigmaBp: sigma.mul(10_000).toFixed(1),
  naiveSigmaBp: naive.mul(10_000).toFixed(1),
  seedSigmaBp: SEED_SIGMA.mul(10_000).toFixed(1),
  byKind,
};
mkdirSync("docs/evidence", { recursive: true });
const out = `docs/evidence/bell-calibration-${symbol}.json`;
writeFileSync(out, JSON.stringify({ summary, rows }, null, 2) + "\n");

for (const r of rows) {
  if ("errorBp" in r)
    console.log(`${r.kind.padEnd(9)} ${r.closeAt.slice(0, 16)} → ${r.openAt.slice(0, 16)}  real gap ${r.realGapBp.padStart(7)} bp  est ${r.estGapBp.padStart(7)} bp  error ${r.errorBp.padStart(6)} bp  (naive ${r.naiveErrorBp} bp)`);
  else console.log(`${r.kind.padEnd(9)} ${r.closeAt.slice(0, 16)} skipped: ${r.skipped}`);
}
console.log(`\nσ (RMS error) ${summary.sigmaBp} bp over ${ok.length} closures · naive "open = close" ${summary.naiveSigmaBp} bp · seed ${summary.seedSigmaBp} bp`);
console.log(`by kind: ${JSON.stringify(byKind)}`);
console.log(`wrote ${out}`);

import "server-only";
import { currentClosure, isOpen, nextClose, nextOpen, type ClosureKind } from "@glade/calendar";
import { closeSnapshot, gapBand, impliedOpen, referenceSpotSymbol, SEED_SIGMA } from "@glade/engine";
import { dec } from "@glade/shared";
import { cacheLife } from "next/cache";
import calibration from "../../../../docs/evidence/bell-calibration-NVDA.json";
import { tmPublic } from "./tm";

export const BELL_SYMBOLS = ["NVDA", "TSLA", "AAPL", "SPCX"] as const;

export interface BellCard {
  symbol: string;
  close: string | null;
  markNow: string | null;
  impliedOpen: string | null;
  gap: string | null;
  band: string;
  basisBp: string | null;
  error?: string;
}

export interface BellView {
  now: string;
  open: boolean;
  closure: { closeAt: string; openAt: string; kind: ClosureKind } | null;
  nextOpen: string;
  nextClose: string;
  calibration: { sigmaBp: string; closures: number };
  cards: BellCard[];
}

/** ± band for an estimate during a closure of this kind, calibrated on past closures. */
export const bandFor = (kind: ClosureKind) => gapBand(sigmaFor(kind));

function sigmaFor(kind: ClosureKind) {
  const s = calibration.summary;
  const bp = (v: string | null | undefined) => (v ? dec(v).div(10_000) : undefined);
  const all = bp(s.sigmaBp) ?? SEED_SIGMA;
  if (kind === "overnight") return bp(s.byKind.overnight.rmsErrorBp) ?? all;
  return bp(s.byKind.weekend.rmsErrorBp) ?? all;
}

/** Listed spot symbol for a stock (issuer tokens: AAPLC, NVDAon, ...). */
async function spotSymbolFor(symbol: string): Promise<string> {
  "use cache";
  cacheLife("hours");
  const stocks = await tmPublic().listAssets({ asset_class: "stock" });
  return referenceSpotSymbol(symbol, stocks.filter((a) => a.type === "spot").map((a) => a.symbol!).filter(Boolean)) ?? symbol;
}

/** Close price and perp mark in the last minute before the bell. Immutable once the market has closed. */
async function closeSnapshotFor(symbol: string, closeAtIso: string) {
  "use cache";
  cacheLife("days");
  const tm = tmPublic();
  const spot = await spotSymbolFor(symbol);
  const last = async (assetClass?: "perp") =>
    (await tm.priceHistory({ symbol: assetClass ? symbol : spot, window: "15m", resolution: "1m", asOf: closeAtIso, ...(assetClass ? { assetClass } : {}) })).points?.at(-1)?.price ?? null;
  const [close, mark] = await Promise.all([last(), last("perp")]);
  return close && mark ? { close, mark } : null;
}

async function liveMark(symbol: string): Promise<string | null> {
  const r = await tmPublic().prices(symbol, "perp");
  return r.candles?.find((c) => c.interval === "1h")?.closePrice ?? r.candles?.[0]?.closePrice ?? null;
}

export async function getBellView(now: Date): Promise<BellView> {
  const open = isOpen(now);
  const closure = currentClosure(now);
  const kind = closure?.kind ?? "overnight";
  const band = gapBand(sigmaFor(kind));

  const cards: BellCard[] = await Promise.all(
    BELL_SYMBOLS.map(async (symbol): Promise<BellCard> => {
      const base = { symbol, close: null, markNow: null, impliedOpen: null, gap: null, basisBp: null, band: band.toFixed(6) };
      if (!closure) return base;
      try {
        const [snap, mark] = await Promise.all([closeSnapshotFor(symbol, closure.closeAt.toISOString()), liveMark(symbol)]);
        if (!snap || !mark) return { ...base, error: "no perp or price data" };
        const s = closeSnapshot(snap.close, snap.mark);
        const implied = impliedOpen(mark, s.basis);
        return {
          ...base,
          close: s.close.toFixed(2),
          markNow: dec(mark).toFixed(2),
          impliedOpen: implied.toFixed(2),
          gap: implied.div(s.close).minus(1).toFixed(6),
          basisBp: s.basis.mul(10_000).toFixed(1),
        };
      } catch (e) {
        return { ...base, error: String(e).slice(0, 120) };
      }
    }),
  );

  return {
    now: now.toISOString(),
    open,
    closure: closure ? { closeAt: closure.closeAt.toISOString(), openAt: closure.openAt.toISOString(), kind: closure.kind } : null,
    nextOpen: nextOpen(now).toISOString(),
    nextClose: nextClose(now).toISOString(),
    calibration: { sigmaBp: calibration.summary.sigmaBp, closures: calibration.summary.used },
    cards,
  };
}

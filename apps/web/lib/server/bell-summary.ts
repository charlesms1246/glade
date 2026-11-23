import { dec } from "@glade/shared";

export interface ReportLeg {
  symbol: string;
  estGap: string;
  realisedGap: string;
  /** ± band shown with the estimate, as a fraction; null when unknown. */
  band: string | null;
  hedgePnl: string;
}

export interface BellAggregate {
  reports: number;
  legs: number;
  /** Mean |realised − estimate| in basis points, or null with no legs. */
  meanAbsErrorBp: string | null;
  /** Share of legs whose realised gap fell inside estimate ± band, or null when no leg has a band. */
  hitRate: string | null;
}

/** Accuracy of Bell's opening estimates across reports. */
export function aggregateBell(reports: readonly { legs: readonly ReportLeg[] }[]): BellAggregate {
  const legs = reports.flatMap((r) => r.legs);
  if (legs.length === 0) return { reports: reports.length, legs: 0, meanAbsErrorBp: null, hitRate: null };
  const errs = legs.map((l) => dec(l.realisedGap).minus(dec(l.estGap)).abs());
  const mean = errs.reduce((a, e) => a.plus(e), dec(0)).div(errs.length).mul(10_000);
  const banded = legs.map((l, i) => ({ l, err: errs[i]! })).filter((x) => x.l.band !== null);
  const hits = banded.filter((x) => x.err.lte(dec(x.l.band!))).length;
  return {
    reports: reports.length,
    legs: legs.length,
    meanAbsErrorBp: mean.toFixed(0),
    hitRate: banded.length ? dec(hits).div(banded.length).toFixed(4) : null,
  };
}

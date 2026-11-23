import { Decimal, dec, type DecimalLike } from "@glade/shared";

/** Seed closure-error sigma (80 bp) until calibrated. */
export const SEED_SIGMA = new Decimal("0.008");

export interface CloseSnapshot {
  close: Decimal;
  mark: Decimal;
  /** mark / close − 1 at the session close. */
  basis: Decimal;
}

export function closeSnapshot(close: DecimalLike, mark: DecimalLike): CloseSnapshot {
  const c = dec(close);
  const m = dec(mark);
  if (c.lte(0) || m.lte(0)) throw new Error("prices must be positive");
  return { close: c, mark: m, basis: m.div(c).minus(1) };
}

/** Implied opening price: the live perp mark with the close-time basis removed. */
export function impliedOpen(markNow: DecimalLike, basis: DecimalLike): Decimal {
  return dec(markNow).div(dec(basis).plus(1));
}

/** Estimated gap of the implied open versus the close, as a fraction. */
export function impliedGap(snapshot: CloseSnapshot, markNow: DecimalLike): Decimal {
  return impliedOpen(markNow, snapshot.basis).div(snapshot.close).minus(1);
}

/** Dollar gap across holdings: Σ gap × value. */
export function portfolioGapUsd(items: readonly { gap: DecimalLike; value: DecimalLike }[]): Decimal {
  return items.reduce((a, i) => a.plus(dec(i.gap).mul(dec(i.value))), new Decimal(0));
}

/** ± band around the estimate: z × σ. */
export function gapBand(sigma: DecimalLike = SEED_SIGMA, z: DecimalLike = 1): Decimal {
  return dec(z).mul(dec(sigma));
}

/** Calibrated sigma: RMS of (implied − actual) open errors as fractions. Seed if none. */
export function calibrateSigma(errors: readonly DecimalLike[]): Decimal {
  if (errors.length === 0) return SEED_SIGMA;
  const ss = errors.reduce<Decimal>((a, e) => a.plus(dec(e).pow(2)), new Decimal(0));
  return ss.div(errors.length).sqrt();
}

export interface BellReportInput {
  close: DecimalLike;
  open: DecimalLike;
  /** Short hedge quantity in base units (positive). */
  hedgeQty: DecimalLike;
  /** Holding value at the close. */
  value: DecimalLike;
  /** Gap estimated before the open, as a fraction. */
  estGap: DecimalLike;
  fees: DecimalLike;
  /** Net funding paid; negative when funding was received. */
  funding: DecimalLike;
}

export interface BellReport {
  realisedGap: Decimal;
  estGapUsd: Decimal;
  realGapUsd: Decimal;
  /** Hedge P&L minus costs. */
  saved: Decimal;
  cost: Decimal;
  /** |estimated − realised| in basis points. */
  accuracyBp: Decimal;
}

export function bellReport(i: BellReportInput): BellReport {
  const close = dec(i.close);
  const realisedGap = dec(i.open).div(close).minus(1);
  const cost = dec(i.fees).plus(dec(i.funding));
  const saved = realisedGap.neg().mul(dec(i.hedgeQty)).mul(close).minus(cost);
  return {
    realisedGap,
    estGapUsd: dec(i.estGap).mul(dec(i.value)),
    realGapUsd: realisedGap.mul(dec(i.value)),
    saved,
    cost,
    accuracyBp: dec(i.estGap).minus(realisedGap).abs().mul(10_000),
  };
}

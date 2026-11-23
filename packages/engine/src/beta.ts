import { Decimal, dec, type DecimalLike } from "@glade/shared";

export interface BetaResult {
  /** Shrunk beta, or 1 when the fit is low-confidence. */
  beta: Decimal;
  rawBeta: Decimal;
  r2: Decimal;
  /** Number of return observations. */
  n: number;
  lowConfidence: boolean;
}

export const BETA_MIN_POINTS = 30;
export const BETA_MIN_R2 = new Decimal("0.2");
const SHRINK_WEIGHT = new Decimal("0.67");
const SHRINK_TARGET = new Decimal(1);

export function logReturns(closes: readonly DecimalLike[]): Decimal[] {
  const out: Decimal[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = dec(closes[i - 1]!);
    const cur = dec(closes[i]!);
    if (prev.lte(0) || cur.lte(0)) throw new Error("closes must be positive");
    out.push(cur.div(prev).ln());
  }
  return out;
}

/** Shrink a raw OLS beta towards 1: 0.67·β + 0.33. */
export function shrinkBeta(beta: DecimalLike): Decimal {
  return SHRINK_WEIGHT.mul(dec(beta)).plus(new Decimal(1).minus(SHRINK_WEIGHT).mul(SHRINK_TARGET));
}

/**
 * OLS beta of a stock against an index from aligned daily closes (same dates, same order).
 * Falls back to beta 1 with lowConfidence when there are fewer than 30 returns or R² < 0.2.
 */
export function estimateBeta(
  stockCloses: readonly DecimalLike[],
  indexCloses: readonly DecimalLike[],
): BetaResult {
  if (stockCloses.length !== indexCloses.length) throw new Error("close series must be aligned");
  const y = logReturns(stockCloses);
  const x = logReturns(indexCloses);
  const n = x.length;
  const zero = new Decimal(0);
  if (n < 2) return { beta: new Decimal(1), rawBeta: zero, r2: zero, n, lowConfidence: true };

  const mean = (v: Decimal[]) => v.reduce((a, b) => a.plus(b), zero).div(v.length);
  const mx = mean(x);
  const my = mean(y);
  let sxy = zero;
  let sxx = zero;
  let syy = zero;
  for (let i = 0; i < n; i++) {
    const dx = x[i]!.minus(mx);
    const dy = y[i]!.minus(my);
    sxy = sxy.plus(dx.mul(dy));
    sxx = sxx.plus(dx.mul(dx));
    syy = syy.plus(dy.mul(dy));
  }
  if (sxx.isZero()) return { beta: new Decimal(1), rawBeta: zero, r2: zero, n, lowConfidence: true };

  const rawBeta = sxy.div(sxx);
  const r2 = syy.isZero() ? zero : sxy.mul(sxy).div(sxx.mul(syy));
  const lowConfidence = n < BETA_MIN_POINTS || r2.lt(BETA_MIN_R2);
  return {
    beta: lowConfidence ? new Decimal(1) : shrinkBeta(rawBeta),
    rawBeta,
    r2,
    n,
    lowConfidence,
  };
}

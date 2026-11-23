import Decimal from "decimal.js";

// Money and prices are always decimals built from strings; never JS floats.
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

export { Decimal };
export type DecimalLike = Decimal | string | number;

/** Build a Decimal. Numbers are accepted only for small integer/constant literals. */
export function dec(v: DecimalLike): Decimal {
  if (v instanceof Decimal) return v;
  if (typeof v === "number" && !Number.isFinite(v)) throw new Error(`non-finite number: ${v}`);
  return new Decimal(v);
}

/** Round a quantity DOWN to a multiple of `step` (never round sizes up). */
export function floorToStep(qty: DecimalLike, step: DecimalLike): Decimal {
  const q = dec(qty);
  const s = dec(step);
  if (s.lte(0)) throw new Error("step must be > 0");
  if (q.lte(0)) return new Decimal(0);
  return q.div(s).floor().mul(s);
}

export const ZERO = new Decimal(0);
export const ONE = new Decimal(1);

export function dmin(...xs: Decimal[]): Decimal {
  return Decimal.min(...xs);
}
export function dmax(...xs: Decimal[]): Decimal {
  return Decimal.max(...xs);
}

/** Format USD for display, e.g. "$1,234.56" / "−$12.00". */
export function fmtUsd(v: DecimalLike, dp = 2): string {
  const d = dec(v);
  const abs = d.abs().toFixed(dp, Decimal.ROUND_HALF_EVEN);
  const [int, frac] = abs.split(".");
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${d.isNeg() && !d.isZero() ? "−" : ""}$${grouped}${frac ? `.${frac}` : ""}`;
}

/** Format a ratio as a percent string, e.g. 0.0412 → "4.12%". */
export function fmtPct(v: DecimalLike, dp = 2): string {
  return `${dec(v).mul(100).toFixed(dp, Decimal.ROUND_HALF_EVEN)}%`;
}

/** Rounds away amounts too small to show, so "−$0.00" never appears. */
const shown = (v: string | number, dp: number) => {
  const n = Number(v);
  return Math.abs(n) < 0.5 * 10 ** -dp ? 0 : n;
};

/** Display-only formatting of decimal strings from the server. */
export const usd = (v: string | number, dp = 2) => {
  const n = shown(v, dp);
  return `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
};
export const signedUsd = (v: string | number, dp = 2) => `${shown(v, dp) > 0 ? "+" : ""}${usd(v, dp)}`;
/** True when the amount shows as negative at this precision. */
export const isNeg = (v: string | number | null | undefined, dp = 2) => shown(v ?? 0, dp) < 0;
export const pct = (v: string | number, dp = 0) => `${(Number(v) * 100).toFixed(dp)}%`;
export const qty = (v: string | number, dp = 6) => Number(v).toLocaleString("en-US", { maximumFractionDigits: dp });

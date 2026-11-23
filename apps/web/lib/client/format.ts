/** Display-only formatting of decimal strings from the server. */
export const usd = (v: string | number, dp = 2) => {
  const n = Number(v);
  return `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
};
export const signedUsd = (v: string | number, dp = 2) => `${Number(v) > 0 ? "+" : ""}${usd(v, dp)}`;
export const pct = (v: string | number, dp = 0) => `${(Number(v) * 100).toFixed(dp)}%`;
export const qty = (v: string | number, dp = 6) => Number(v).toLocaleString("en-US", { maximumFractionDigits: dp });

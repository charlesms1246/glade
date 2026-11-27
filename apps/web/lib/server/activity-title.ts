const DECISION_TITLE: Record<string, string> = {
  bell_report: "Bell report",
  bell_report_unavailable: "Bell report unavailable",
  bell_snapshot: "Bell estimate saved",
  bell_unwind_stuck: "Bell unwind needs attention",
  floor_wind_down: "Floor wound down",
};

/** Plain-English title for an engine decision; unknown actions fall back to their words. */
export const decisionTitle = (action: string) => DECISION_TITLE[action] ?? action.replaceAll("_", " ");

const usd = (v: string) => `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Plain-English title for an order. `qty` is a decimal string in `qtyUnit` (USD for "quote"). */
export function orderTitle(kind: string, qty: string, qtyUnit: string, symbol: string): string {
  const amount = qtyUnit === "quote" ? `${usd(qty)} of ${symbol}` : `${qty} ${symbol}`;
  switch (kind) {
    case "spot_buy":
      return `Buy ${amount}`;
    case "spot_sell":
      return `Sell ${amount}`;
    case "open":
      return `Open a short hedge: ${qty} ${symbol} perp`;
    case "increase":
      return `Raise the hedge: short ${qty} more ${symbol} perp`;
    case "decrease":
      return `Trim the hedge: buy back ${qty} ${symbol} perp`;
    case "close":
      return `Close the hedge: buy back ${qty} ${symbol} perp`;
    default:
      return `${kind.replaceAll("_", " ")}: ${amount}`;
  }
}

import { dec } from "@glade/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { computeHedgeReport, explainReport, type HedgeReport, type LegInputs } from "./compute";

const plan = (extra: Record<string, unknown> = {}) => ({
  kind: "bell",
  rows: [
    { symbol: "NVDAx", valueUsd: "1000", perpSymbol: "NVDA", rejected: null },
    { symbol: "TSLAx", valueUsd: "3000", perpSymbol: "TSLA", rejected: null },
  ],
  legs: [
    { assetId: "p-nvda", symbol: "NVDA", reduceOnly: false },
    { assetId: "p-tsla", symbol: "TSLA", reduceOnly: false },
    { assetId: "p-nvda", symbol: "NVDA", reduceOnly: true },
    { assetId: "p-tsla", symbol: "TSLA", reduceOnly: true },
  ],
  ...extra,
});

const base: LegInputs = {
  plan: plan(),
  fills: [
    { assetId: "p-nvda", kind: "open", executedQty: "10", avgPrice: "101", fee: "0.45" },
    { assetId: "p-nvda", kind: "close", executedQty: "10", avgPrice: "103", fee: "0.46" },
    { assetId: "p-tsla", kind: "open", executedQty: "10", avgPrice: "300", fee: "1.35" },
  ],
  snapshots: [
    { symbol: "NVDA", closePx: "100", basis: "0" },
    { symbol: "TSLA", closePx: "300", basis: "0" },
  ],
  openPx: { NVDA: "102", TSLA: "297" },
  fundingReceived: { "p-nvda": "0.1" },
};

const ok = (r: HedgeReport | string): HedgeReport => {
  if (typeof r === "string") throw new Error(r);
  return r;
};

describe("Bell hedge report", () => {
  it("reports each leg with the implied estimate at the open fill when the plan has none", () => {
    const r = ok(computeHedgeReport(base));
    const nvda = r.legs[0]!;
    expect(nvda.estSource).toBe("implied_at_open_fill");
    expect(nvda.estGap.toString()).toBe("0.01"); // open fill 101 vs close 100, basis 0
    expect(nvda.realisedGap.toString()).toBe("0.02");
    // hedge P&L = −0.02 × 10 × 100; costs = fees 0.91 − funding received 0.1
    expect(nvda.hedgePnl.toString()).toBe("-20");
    expect(nvda.cost.toString()).toBe("0.81");
    expect(nvda.saved.toString()).toBe("-20.81");
    expect(nvda.accuracyBp.toString()).toBe("100");
    expect(r.legs[1]!.realisedGap.toString()).toBe("-0.01");
    // value-weighted accuracy: (100 × 1000 + 100 × 3000) / 4000
    expect(r.accuracyBp.toString()).toBe("100");
    expect(r.realGapUsd.toString()).toBe("-10"); // 0.02 × 1000 − 0.01 × 3000
  });

  it("removes the close-time basis from the open fill", () => {
    const r = ok(computeHedgeReport({ ...base, snapshots: [{ symbol: "NVDA", closePx: "100", basis: "0.01" }, base.snapshots[1]!] }));
    expect(r.legs[0]!.estGap.toFixed(6)).toBe("0.000000");
  });

  it("prefers the estimate recorded in the approved plan", () => {
    const r = ok(computeHedgeReport({ ...base, plan: plan({ estimates: { NVDA: "0.016" }, estGapPct: "0.005" }) }));
    expect(r.legs[0]).toMatchObject({ estSource: "plan" });
    expect(r.legs[0]!.estGap.toString()).toBe("0.016");
    expect(r.legs[1]!.estGap.toString()).toBe("0.005");
  });

  it("waits for missing inputs instead of guessing", () => {
    expect(computeHedgeReport({ ...base, openPx: { NVDA: "102" } })).toBe("no post-open price for TSLA");
    expect(computeHedgeReport({ ...base, snapshots: [] })).toBe("no close snapshot for NVDA");
    expect(computeHedgeReport({ ...base, plan: { kind: "shield" } })).toBe("plan is not a bell plan");
    expect(computeHedgeReport({ ...base, fills: [] })).toBe("no filled legs");
  });

  it("writes a plain-English line", () => {
    const r = ok(computeHedgeReport({ ...base, plan: { ...plan(), rows: [plan().rows[0]] } }));
    expect(explainReport(r, dec("0.023"))).toBe(
      "Bell report: NVDA opened +2.0% vs estimate +1.0% (±2.3%). Hedge P&L −$20.00, costs $0.81, net saved −$20.81.",
    );
  });

  it("saved = hedge P&L − costs, and the hedge offsets the gap on the hedged quantity", () => {
    const px = fc.integer({ min: 1, max: 100_000 }).map((n) => dec(n).div(100).toFixed());
    fc.assert(
      fc.property(px, px, fc.integer({ min: 1, max: 1000 }), (close, open, q) => {
        const r = ok(
          computeHedgeReport({
            plan: { ...plan(), rows: [plan().rows[0]] },
            fills: [{ assetId: "p-nvda", kind: "open", executedQty: String(q), avgPrice: close, fee: "1" }],
            snapshots: [{ symbol: "NVDA", closePx: close, basis: "0" }],
            openPx: { NVDA: open },
            fundingReceived: {},
          }),
        );
        const l = r.legs[0]!;
        expect(l.saved.toString()).toBe(l.hedgePnl.minus(l.cost).toString());
        expect(l.hedgePnl.plus(dec(open).minus(close).mul(q)).abs().lte("1e-20")).toBe(true);
      }),
    );
  });
});

import { dec } from "@glade/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decideFloor, type FloorInputs, type FloorMandate, type FloorParams } from "./decide";

const mandate: FloorMandate = {
  floorPct: "0.85",
  multiplier: "4",
  ratchet: false,
  baseUsd: "1000",
  leverageMax: "3",
  allowedPerps: ["perp-nvda"],
  maxTradesDay: 10,
};
const params: FloorParams = { band: "0.05", cooldownSec: 600, minNotionalUsd: "10", leverage: "2", sizeStep: () => "0.001" };
const perps = [{ asset_id: "perp-nvda", symbol: "NVDA", max_leverage: 20 }, { asset_id: "perp-sp", symbol: "SP500", max_leverage: 50 }];
const state = { peak: null, lastTradeAt: null, tradesToday: 0 };
const now = new Date("2026-11-24T15:00:00Z");

const inputs = (equity: string, stock: string, short = "0"): FloorInputs => ({
  equity,
  holdings: [{ asset_id: "a", economic_asset_id: "e", symbol: "NVDAC", value: stock }],
  positions: short === "0" ? [] : [{ asset_id: "perp-nvda", size: short, mark_price: "100" }],
  perps,
  marks: { "perp-nvda": "100" },
});

describe("decideFloor", () => {
  it("opens a short when the cushion is thin", () => {
    // equity 900, floor 850, cushion 50 → exposure 200, hedge 700 of 900 stock
    const d = decideFloor(mandate, state, inputs("900", "900"), params, now);
    expect(d.drafts).toEqual([
      { kind: "open", assetId: "perp-nvda", side: "sell", qty: "7", leverage: "2", reduceOnly: false, notionalUsd: "700.00", beta: "1" },
    ]);
    expect(d.explanation).toMatch(/^Hedge raised/);
  });

  it("reduces with a reduce-only buy when the cushion recovers", () => {
    const d = decideFloor(mandate, state, inputs("1000", "1000", "7"), params, now);
    // equity 1000, floor 850 → exposure 600, hedge 400 → reduce 3
    expect(d.drafts).toEqual([
      { kind: "decrease", assetId: "perp-nvda", side: "buy", qty: "3", leverage: null, reduceOnly: true, notionalUsd: "300.00", beta: "1" },
    ]);
  });

  it("does nothing inside the band or during cooldown", () => {
    expect(decideFloor(mandate, state, inputs("1000", "1000", "4.1"), params, now).drafts).toEqual([]);
    const cooling = { ...state, lastTradeAt: new Date(now.getTime() - 60_000) };
    const d = decideFloor(mandate, cooling, inputs("900", "900"), params, now);
    expect(d.drafts).toEqual([]);
    expect(d.explanation).toContain("cooldown");
  });

  it("skips perps the mandate does not allow", () => {
    const d = decideFloor({ ...mandate, allowedPerps: [] }, state, inputs("900", "900"), params, now);
    expect(d.drafts).toEqual([]);
    expect(d.skipped[0]).toContain("not allowed");
  });

  it("caps leverage at the mandate maximum", () => {
    const d = decideFloor({ ...mandate, leverageMax: "1.5" }, state, inputs("900", "900"), params, now);
    expect(d.drafts[0]!.leverage).toBe("1.5");
  });

  it("property: never sells more than the stock value and never buys more than the short", () => {
    fc.assert(
      fc.property(fc.integer({ min: 100, max: 5000 }), fc.integer({ min: 0, max: 60 }), (stock, short) => {
        const d = decideFloor(mandate, state, inputs(String(stock), String(stock), String(short)), params, now);
        return d.drafts.every((x) =>
          x.side === "sell" ? dec(x.qty).plus(short).mul(100).lte(stock) : x.reduceOnly && dec(x.qty).lte(short),
        );
      }),
    );
  });
});

describe("issuer tokens in Floor", () => {
  it("hedges an xStocks holding with its matching perp", () => {
    const inp = {
      equity: "900",
      holdings: [{ asset_id: "a", economic_asset_id: "e", symbol: "AMDX", value: "900" }],
      positions: [],
      perps: [{ asset_id: "perp-amd", symbol: "AMD" }, { asset_id: "perp-sp", symbol: "SP500" }],
      marks: { "perp-amd": "100" },
    };
    const d = decideFloor({ ...mandate, allowedPerps: ["perp-amd"] }, state, inp, params, now);
    expect(d.drafts[0]?.assetId).toBe("perp-amd");
  });
});

describe("decideFloor with no holdings left", () => {
  it("closes the Floor's own short reduce-only, even inside the cooldown", () => {
    const empty: FloorInputs = { equity: "1000", holdings: [], positions: [{ asset_id: "perp-nvda", size: "7", mark_price: "100" }], perps, marks: {} };
    const cooling = { ...state, lastTradeAt: new Date(now.getTime() - 1000) };
    const d = decideFloor(mandate, cooling, empty, params, now);
    expect(d.drafts).toEqual([
      { kind: "decrease", assetId: "perp-nvda", side: "buy", qty: "7", leverage: null, reduceOnly: true, notionalUsd: "700.00", beta: "1" },
    ]);
    expect(d.explanation).toMatch(/no matching stock is held any more/);
  });
  it("does nothing when there is no short either", () => {
    expect(decideFloor(mandate, state, { equity: "1000", holdings: [], positions: [], perps, marks: {} }, params, now).drafts).toEqual([]);
  });
});

describe("decideFloor guards", () => {
  it("reduces a hedge above 1.05 x holdings even inside the cooldown, never increasing", () => {
    // 3 held (value 300), short 7 (value 700): over-hedged, cushion large so the target is 0
    const over = inputs("1000", "300", "7");
    const cooling = { ...state, lastTradeAt: new Date(now.getTime() - 1000) };
    const d = decideFloor(mandate, cooling, over, params, now);
    expect(d.drafts).toHaveLength(1);
    expect(d.drafts[0]).toMatchObject({ kind: "decrease", side: "buy", reduceOnly: true });
  });
  it("does not trade inside the cooldown when not over-hedged", () => {
    const cooling = { ...state, lastTradeAt: new Date(now.getTime() - 1000) };
    expect(decideFloor(mandate, cooling, inputs("900", "900"), params, now).drafts).toEqual([]);
  });
  it("warns about a close liquidation price and negative funding without trading", () => {
    const i = inputs("900", "900", "7");
    const d = decideFloor(mandate, state, { ...i, positions: [{ ...i.positions[0]!, liquidation_price: "105" }], funding: { "perp-nvda": "-0.0001" } }, params, now);
    expect(d.warnings).toHaveLength(2);
    expect(d.warnings[0]).toMatch(/NVDA short is 5\.0% from its liquidation price/);
    expect(d.warnings[1]).toMatch(/funding costs 88% a year/);
  });
});

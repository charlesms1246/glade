import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { chooseInstrument, groupHoldings, normalizeSymbol, type PerpListing } from "./mapping";

const perps: PerpListing[] = [
  { asset_id: "p-nvda", symbol: "NVDA" },
  { asset_id: "p-aapl", symbol: "AAPL" },
  { asset_id: "p-sp500", symbol: "SP500" },
  { asset_id: "p-xyz", symbol: "XYZ100" },
];
const bases = new Set(perps.map((p) => p.symbol));

describe("normalizeSymbol", () => {
  it("maps issuer aliases", () => {
    expect(normalizeSymbol("NVDAC")).toBe("NVDA");
    expect(normalizeSymbol("AAPLx")).toBe("AAPL");
    expect(normalizeSymbol("SPCXC")).toBe("SPCX");
    expect(normalizeSymbol("TSLA")).toBe("TSLA");
  });
  it("strips a C/x suffix only for known bases", () => {
    expect(normalizeSymbol("MUC", new Set(["MU"]))).toBe("MU");
    expect(normalizeSymbol("CRWC", new Set(["MU"]))).toBe("CRWC");
    expect(normalizeSymbol("SPCX", new Set(["SPC", "SPCX"]))).toBe("SPCX");
  });
  it("is idempotent", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Z]{1,6}[CX]?$/), (s) => {
        const once = normalizeSymbol(s, bases);
        return normalizeSymbol(once, bases) === once;
      }),
    );
  });
});

describe("groupHoldings", () => {
  it("sums by economic asset and names by base symbol", () => {
    const g = groupHoldings(
      [
        { asset_id: "a1", economic_asset_id: "e-nvda", symbol: "NVDAC", value: "10" },
        { asset_id: "a2", economic_asset_id: "e-nvda", symbol: "NVDA", value: "5.5" },
        { asset_id: "a3", economic_asset_id: "e-aapl", symbol: "AAPLx", value: "3" },
      ],
      bases,
    );
    expect(g).toHaveLength(2);
    const nvda = g.find((x) => x.economic_asset_id === "e-nvda")!;
    expect(nvda.symbol).toBe("NVDA");
    expect(nvda.value.toString()).toBe("15.5");
    expect(nvda.asset_ids).toEqual(["a1", "a2"]);
  });
});

describe("chooseInstrument", () => {
  it("uses a matched perp with beta 1", () => {
    const leg = chooseInstrument({ economic_asset_id: "e", symbol: "NVDA" }, perps)!;
    expect(leg.method).toBe("matched");
    expect(leg.perp_asset_id).toBe("p-nvda");
    expect(leg.beta.toString()).toBe("1");
  });
  it("falls back to SP500 for an unknown stock", () => {
    const leg = chooseInstrument({ economic_asset_id: "e", symbol: "MSFT" }, perps, {
      SP500: { beta: "1.1", r2: "0.5", corr: "0.7" },
    })!;
    expect(leg.method).toBe("index");
    expect(leg.perp_symbol).toBe("SP500");
    expect(leg.beta.toString()).toBe("1.1");
    expect(leg.lowConfidence).toBe(false);
  });
  it("prefers XYZ100 when its correlation is higher", () => {
    const leg = chooseInstrument({ economic_asset_id: "e", symbol: "MSFT" }, perps, {
      SP500: { beta: "1", r2: "0.4", corr: "0.6" },
      XYZ100: { beta: "0.9", r2: "0.6", corr: "0.8" },
    })!;
    expect(leg.perp_symbol).toBe("XYZ100");
  });
  it("flags low confidence when no stats are given", () => {
    const leg = chooseInstrument({ economic_asset_id: "e", symbol: "MSFT" }, perps)!;
    expect(leg.lowConfidence).toBe(true);
    expect(leg.beta.toString()).toBe("1");
  });
  it("returns null when no perp is usable", () => {
    expect(chooseInstrument({ economic_asset_id: "e", symbol: "MSFT" }, [])).toBeNull();
  });
});

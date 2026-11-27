import { dec } from "@glade/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { allocateExisting, hedgedShare, overHedgedPerps, remainingValue } from "./shield-sizing";

describe("remainingValue", () => {
  it("is the full value with nothing hedged", () => {
    expect(remainingValue(dec(1000), dec(1), dec("0.5"), dec(0)).toFixed()).toBe("1000");
  });
  it("sizes only the gap to the target", () => {
    // target 750 (75% of 1000), 500 already short -> new notional 250 = 0.75 * 333.33
    const v = remainingValue(dec(1000), dec(1), dec("0.75"), dec(500));
    expect(v.mul("0.75").toFixed(2)).toBe("250.00");
  });
  it("is zero when already at or over the target", () => {
    expect(remainingValue(dec(1000), dec(1), dec("0.5"), dec(800)).toFixed()).toBe("0");
  });
  it("never goes negative and never exceeds the value", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1e6 }), fc.integer({ min: 1, max: 100 }), fc.integer({ min: 1, max: 300 }), fc.integer({ min: 0, max: 1e6 }), (v, r, b, c) => {
        const out = remainingValue(dec(v), dec(b).div(100), dec(r).div(100), dec(c));
        return out.gte(0) && out.lte(v);
      }),
    );
  });
});

describe("allocateExisting", () => {
  it("shares one perp across groups, capped at each target", () => {
    const g = [
      { perpAssetId: "p", value: dec(1000), beta: dec(1) },
      { perpAssetId: "p", value: dec(1000), beta: dec(1) },
    ];
    const out = allocateExisting(g, dec("0.5"), new Map([["p", dec(700)]]));
    expect(out.map((d) => d.toFixed())).toEqual(["500", "200"]);
  });
});

describe("hedgedShare", () => {
  it("is zero without capacity", () => expect(hedgedShare(dec(0), dec(5)).toFixed()).toBe("0"));
  it("exceeds 1 when over-hedged", () => expect(hedgedShare(dec(100), dec(150)).toFixed()).toBe("1.5"));
});

describe("overHedgedPerps", () => {
  const rows = [{ perpSymbol: "NVDA", valueUsd: "1000", beta: "1" }];
  it("allows existing plus new up to capacity", () => {
    expect(overHedgedPerps(rows, [{ symbol: "NVDA", notionalUsd: "400" }], new Map([["NVDA", dec(600)]]))).toEqual([]);
  });
  it("refuses stacking beyond capacity", () => {
    expect(overHedgedPerps(rows, [{ symbol: "NVDA", notionalUsd: "750" }], new Map([["NVDA", dec(750)]]))).toEqual(["NVDA"]);
  });
});

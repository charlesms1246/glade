import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Decimal } from "@glade/shared";
import { estimateBeta, shrinkBeta } from "./beta";

/** Build a price path from log returns. */
function path(returns: Decimal[], start = 100): Decimal[] {
  const out = [new Decimal(start)];
  for (const r of returns) out.push(out[out.length - 1]!.mul(r.exp()));
  return out;
}

const idxReturns = (n: number) =>
  Array.from({ length: n }, (_, i) => new Decimal(((i * 37) % 11) - 5).div(500));

describe("estimateBeta", () => {
  it("recovers an exact linear relationship and shrinks it", () => {
    const x = idxReturns(60);
    const r = estimateBeta(path(x.map((v) => v.mul(2))), path(x));
    expect(r.rawBeta.toDecimalPlaces(8).toString()).toBe("2");
    expect(r.r2.toDecimalPlaces(8).toString()).toBe("1");
    expect(r.beta.toDecimalPlaces(8).toString()).toBe("1.67");
    expect(r.lowConfidence).toBe(false);
  });
  it("falls back to 1 with fewer than 30 returns", () => {
    const x = idxReturns(10);
    const r = estimateBeta(path(x), path(x));
    expect(r.lowConfidence).toBe(true);
    expect(r.beta.toString()).toBe("1");
  });
  it("falls back to 1 when R² is low", () => {
    const x = idxReturns(60);
    const y = x.map((_, i) => new Decimal(i % 2 === 0 ? "0.01" : "-0.01"));
    const r = estimateBeta(path(y), path(x));
    expect(r.r2.lt("0.2")).toBe(true);
    expect(r.beta.toString()).toBe("1");
  });
  it("rejects misaligned series", () => {
    expect(() => estimateBeta(["1", "2"], ["1"])).toThrow();
  });
  it("property: r2 in [0,1] and exact multiples are recovered", () => {
    fc.assert(
      fc.property(fc.integer({ min: -30, max: 30 }), (k) => {
        const x = idxReturns(40);
        const kk = new Decimal(k).div(10);
        const r = estimateBeta(path(x.map((v) => v.mul(kk))), path(x));
        return r.r2.gte(0) && r.r2.lte("1.0000001") && r.rawBeta.minus(kk).abs().lt("1e-9");
      }),
      { numRuns: 25 },
    );
  });
});

describe("shrinkBeta", () => {
  it("pulls towards 1", () => {
    expect(shrinkBeta("1").toString()).toBe("1");
    expect(shrinkBeta("0").toString()).toBe("0.33");
  });
});

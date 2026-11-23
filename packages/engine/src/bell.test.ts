import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Decimal } from "@glade/shared";
import {
  SEED_SIGMA,
  bellReport,
  calibrateSigma,
  closeSnapshot,
  gapBand,
  impliedGap,
  impliedOpen,
  portfolioGapUsd,
} from "./bell";

describe("bell", () => {
  it("captures basis at the close", () => {
    expect(closeSnapshot("100", "100.05").basis.toString()).toBe("0.0005");
  });
  it("estimates the gap from a moved mark", () => {
    const s = closeSnapshot("100", "101");
    const g = impliedGap(s, "98.98");
    expect(g.toDecimalPlaces(6).toString()).toBe("-0.02");
  });
  it("sums dollar gaps", () => {
    expect(portfolioGapUsd([{ gap: "-0.02", value: "500" }, { gap: "0.01", value: "100" }]).toString()).toBe("-9");
  });
  it("band defaults to the 80bp seed", () => {
    expect(gapBand().toString()).toBe("0.008");
    expect(gapBand("0.01", "2").toString()).toBe("0.02");
  });
  it("calibrates sigma as RMS, seeded when empty", () => {
    expect(calibrateSigma([]).eq(SEED_SIGMA)).toBe(true);
    expect(calibrateSigma(["0.01", "-0.01"]).toString()).toBe("0.01");
  });
  it("reports saved money net of costs", () => {
    const r = bellReport({
      close: "100",
      open: "97",
      hedgeQty: "0.5",
      value: "75",
      estGap: "-0.025",
      fees: "0.05",
      funding: "0.01",
    });
    expect(r.realisedGap.toString()).toBe("-0.03");
    expect(r.saved.toString()).toBe("1.44");
    expect(r.accuracyBp.toString()).toBe("50");
    expect(r.realGapUsd.toString()).toBe("-2.25");
  });
  it("property: implied open equals close when the mark is unchanged", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), fc.integer({ min: -500, max: 500 }), (c, bp) => {
        const close = new Decimal(c).div(100);
        const mark = close.mul(new Decimal(bp).div(10_000).plus(1));
        const s = closeSnapshot(close, mark);
        return impliedOpen(mark, s.basis).minus(close).abs().lt("1e-20");
      }),
    );
  });
});

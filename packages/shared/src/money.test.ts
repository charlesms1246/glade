import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { dec, floorToStep, fmtPct, fmtUsd } from "./money";

describe("floorToStep", () => {
  it("rounds down to the step", () => {
    expect(floorToStep("1.2345", "0.01").toString()).toBe("1.23");
    expect(floorToStep("0.0099", "0.01").toString()).toBe("0");
    expect(floorToStep("10", "0.5").toString()).toBe("10");
  });
  it("never exceeds the input and stays within one step", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.constantFrom("1", "0.1", "0.01", "0.001", "0.25"),
        (n, step) => {
          const q = dec(n).div(1000);
          const r = floorToStep(q, step);
          return r.lte(q) && q.minus(r).lt(dec(step)) && r.div(step).isInteger();
        },
      ),
    );
  });
  it("rejects non-positive steps", () => {
    expect(() => floorToStep("1", "0")).toThrow();
  });
});

describe("formatting", () => {
  it("formats USD and percent", () => {
    expect(fmtUsd("1234.5")).toBe("$1,234.50");
    expect(fmtUsd("-12")).toBe("−$12.00");
    expect(fmtPct("0.0412")).toBe("4.12%");
  });
});

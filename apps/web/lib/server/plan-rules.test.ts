import { describe, expect, it } from "vitest";
import { bellPlanError, bellUnwindAt, legsOverCap } from "./plan-rules";

// Thanksgiving 2026: NYSE closes 2026-11-25 21:00Z and reopens 2026-11-27 14:30Z.
const thanksgiving = { openAt: new Date("2026-11-27T14:30:00Z") };

describe("bell plan rules", () => {
  it("unwinds five minutes after the open", () => {
    expect(bellUnwindAt(thanksgiving)).toBe("2026-11-27T14:35:00.000Z");
  });
  it("accepts a plan only during its own closure", () => {
    expect(bellPlanError("2026-11-27T14:35:00.000Z", thanksgiving)).toBeNull();
    expect(bellPlanError("2026-11-27T14:35:00.000Z", null)).toMatch(/opened/);
    expect(bellPlanError("2026-11-30T14:35:00.000Z", thanksgiving)).toMatch(/different/);
    expect(bellPlanError(undefined, thanksgiving)).toMatch(/different/);
  });
});

describe("order cap", () => {
  it("flags only legs strictly above the limit", () => {
    const legs = [{ notionalUsd: "10000" }, { notionalUsd: "10000.01" }, { notionalUsd: "5" }];
    expect(legsOverCap(legs, "10000")).toEqual([{ notionalUsd: "10000.01" }]);
  });
});

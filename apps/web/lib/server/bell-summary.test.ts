import { describe, expect, it } from "vitest";
import { aggregateBell } from "./bell-summary";

const leg = (estGap: string, realisedGap: string, band: string | null) => ({ symbol: "NVDA", estGap, realisedGap, band, hedgePnl: "0" });

describe("aggregateBell", () => {
  it("reports mean absolute error in bp and the in-band hit rate", () => {
    const a = aggregateBell([{ legs: [leg("0.02", "0.03", "0.05"), leg("-0.01", "-0.07", "0.05")] }, { legs: [leg("0", "0.002", null)] }]);
    expect(a.reports).toBe(2);
    expect(a.legs).toBe(3);
    // |0.01| + |0.06| + |0.002| = 0.072 / 3 = 0.024 → 240 bp
    expect(a.meanAbsErrorBp).toBe("240");
    // Only banded legs count: 1 of 2 inside.
    expect(a.hitRate).toBe("0.5000");
  });

  it("is empty-safe", () => {
    expect(aggregateBell([])).toEqual({ reports: 0, legs: 0, meanAbsErrorBp: null, hitRate: null });
    expect(aggregateBell([{ legs: [leg("0", "0", null)] }]).hitRate).toBeNull();
  });

  it("counts a miss exactly on the band edge as a hit", () => {
    expect(aggregateBell([{ legs: [leg("0.01", "0.06", "0.05")] }]).hitRate).toBe("1.0000");
  });
});

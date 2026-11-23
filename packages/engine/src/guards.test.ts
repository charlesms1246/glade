import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Decimal } from "@glade/shared";
import { GUARD_DEFAULTS, evaluateGuards, type GuardInputs } from "./guards";

const now = new Date("2026-11-24T15:00:00Z");
const base: GuardInputs = {
  legs: [{ key: "NVDA", mark: "100", liquidationPrice: "150", fundingRateHourly: "0.00001" }],
  hedgeNow: "50",
  hedgeTarget: "50",
  riskyValue: "100",
  priceAt: now,
  pauseAll: false,
  userRevoked: false,
};
const run = (o: Partial<GuardInputs>) => evaluateGuards({ ...base, ...o }, GUARD_DEFAULTS, now);

describe("guards", () => {
  it("is clear for a healthy hedge", () => {
    expect(run({})).toEqual([]);
  });
  it("warns under 15% and reduces 25% under 8% liquidation distance", () => {
    expect(run({ legs: [{ ...base.legs[0]!, liquidationPrice: "110" }] })[0]!.kind).toBe("warn_liquidation");
    const a = run({ legs: [{ ...base.legs[0]!, liquidationPrice: "105" }] })[0]!;
    expect(a.kind).toBe("reduce_leg");
    if (a.kind === "reduce_leg") expect(a.fraction.toString()).toBe("0.25");
  });
  it("warns when a short pays expensive funding", () => {
    const a = run({ legs: [{ ...base.legs[0]!, fundingRateHourly: "-0.0001" }] });
    expect(a[0]!.kind).toBe("warn_funding");
    expect(run({ legs: [{ ...base.legs[0]!, fundingRateHourly: "0.0001" }] })).toEqual([]);
  });
  it("reduces an over-hedge to target", () => {
    const a = run({ hedgeNow: "110", hedgeTarget: "60" })[0]!;
    expect(a).toMatchObject({ kind: "reduce_to_target" });
    if (a.kind === "reduce_to_target") expect(a.to.toString()).toBe("60");
  });
  it("pauses on stale prices, kill switch and revoke", () => {
    const kinds = run({ priceAt: new Date(now.getTime() - 61_000), pauseAll: true, userRevoked: true }).map(
      (a) => (a.kind === "pause" ? a.reason : a.kind),
    );
    expect(kinds).toEqual(["kill_switch", "revoked", "stale_price"]);
  });
  it("property: funding is only flagged when shorts pay", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1000, max: 1000 }), (r) => {
        const rate = new Decimal(r).div(1_000_000);
        const flagged = run({ legs: [{ ...base.legs[0]!, fundingRateHourly: rate }] }).some(
          (a) => a.kind === "warn_funding",
        );
        return !flagged || rate.lt(0);
      }),
    );
  });
});

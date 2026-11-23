import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Decimal } from "@glade/shared";
import { cppiStep, type CppiParams, type CppiState } from "./cppi";

const params: CppiParams = {
  base: "1000",
  floorPct: "0.85",
  multiplier: "4",
  ratchet: false,
  band: "0.05",
  minNotionalUsd: "10",
  cooldownSec: 600,
  maxTradesDay: 10,
};
const fresh: CppiState = { peak: null, lastTradeAt: null, tradesToday: 0 };
const now = new Date("2026-11-24T15:00:00Z");
const legs = [{ key: "NVDA", beta: "1", value: "800" }];

describe("cppiStep", () => {
  it("computes floor, cushion and hedge target", () => {
    const r = cppiStep(fresh, { equity: "1000", riskyValue: "800", hedgeNow: "0", legs }, params, now);
    expect(r.floor.toString()).toBe("850");
    expect(r.cushion.toString()).toBe("150");
    expect(r.exposureTarget.toString()).toBe("600");
    expect(r.hedgeTarget.toString()).toBe("200");
    expect(r.delta.toString()).toBe("200");
    expect(r.trade).toBe(true);
    expect(r.legTargets[0]!.hedge.toString()).toBe("200");
  });
  it("blocks inside the band, during cooldown, and at the trade cap", () => {
    const r1 = cppiStep(fresh, { equity: "1000", riskyValue: "800", hedgeNow: "180", legs }, params, now);
    expect(r1.blockedBy).toContain("inside_band");
    const recent: CppiState = { peak: null, lastTradeAt: new Date(now.getTime() - 60_000), tradesToday: 10 };
    const r2 = cppiStep(recent, { equity: "1000", riskyValue: "800", hedgeNow: "0", legs }, params, now);
    expect(r2.blockedBy).toEqual(expect.arrayContaining(["cooldown", "trade_cap"]));
    expect(r2.trade).toBe(false);
  });
  it("flags floor at risk below 3% cushion", () => {
    const r = cppiStep(fresh, { equity: "870", riskyValue: "800", hedgeNow: "0", legs }, params, now);
    expect(r.floorAtRisk).toBe(true);
  });
  it("splits the hedge across legs by beta × value", () => {
    const r = cppiStep(
      fresh,
      {
        equity: "1000",
        riskyValue: "800",
        hedgeNow: "0",
        legs: [
          { key: "A", beta: "1", value: "400" },
          { key: "B", beta: "1.5", value: "400" },
        ],
      },
      params,
      now,
    );
    expect(r.legTargets[0]!.hedge.toString()).toBe("80");
    expect(r.legTargets[1]!.hedge.toString()).toBe("120");
  });

  const arb = fc.record({
    equity: fc.integer({ min: 1, max: 100_000 }),
    riskyPct: fc.integer({ min: 0, max: 100 }),
    hedge: fc.integer({ min: 0, max: 100_000 }),
  });

  it("property: 0 ≤ hedge target ≤ risky value", () => {
    fc.assert(
      fc.property(arb, ({ equity, riskyPct, hedge }) => {
        const riskyValue = new Decimal(equity).mul(riskyPct).div(100);
        const r = cppiStep(fresh, { equity, riskyValue, hedgeNow: hedge, legs }, params, now);
        return r.hedgeTarget.gte(0) && r.hedgeTarget.lte(riskyValue);
      }),
    );
  });
  it("property: no trade inside the band", () => {
    fc.assert(
      fc.property(arb, ({ equity, riskyPct, hedge }) => {
        const riskyValue = new Decimal(equity).mul(riskyPct).div(100);
        const r = cppiStep(fresh, { equity, riskyValue, hedgeNow: hedge, legs }, params, now);
        const threshold = Decimal.max(new Decimal(equity).mul("0.05"), 10);
        return r.delta.abs().gte(threshold) || !r.trade;
      }),
    );
  });
  it("property: with ratchet the floor never decreases", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 5000 }), { minLength: 1, maxLength: 30 }), (path) => {
        let state: CppiState = fresh;
        let prev = new Decimal(0);
        for (const v of path) {
          const r = cppiStep(state, { equity: v, riskyValue: v, hedgeNow: 0, legs }, { ...params, ratchet: true }, now);
          if (r.floor.lt(prev)) return false;
          prev = r.floor;
          state = { ...state, peak: r.peak };
        }
        return true;
      }),
    );
  });
});

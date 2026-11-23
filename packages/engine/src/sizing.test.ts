import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Decimal } from "@glade/shared";
import { sizeShield, type ShieldLegInput } from "./sizing";

const leg = (o: Partial<ShieldLegInput> = {}): ShieldLegInput => ({
  economic_asset_id: "e-nvda",
  perp_asset_id: "p-nvda",
  value: "100",
  beta: "1",
  mark: "180",
  sizeStep: "0.001",
  fundingRateHourly: "0.00001",
  ...o,
});

describe("sizeShield", () => {
  it("sizes a 75% hedge at 2x", () => {
    const p = sizeShield([leg()], { ratio: "0.75", leverage: "2", minNotionalUsd: "10", freeUsdc: "100" });
    const l = p.legs[0]!;
    expect(l.targetNotional.toString()).toBe("75");
    expect(l.qty.toString()).toBe("0.416");
    expect(l.notional.toString()).toBe("74.88");
    expect(l.margin.toString()).toBe("37.5");
    expect(p.requiredUsdc.toString()).toBe("41.25");
    expect(p.ok).toBe(true);
    expect(l.fundingPerDay.toString()).toBe("0.0179712");
  });
  it("rejects below min notional", () => {
    const p = sizeShield([leg({ value: "10" })], {
      ratio: "0.5",
      leverage: "2",
      minNotionalUsd: "10",
      freeUsdc: "100",
    });
    expect(p.ok).toBe(false);
    expect(p.reasons).toContain("below_min_notional");
  });
  it("rejects insufficient margin with the 10% buffer", () => {
    const p = sizeShield([leg()], { ratio: "1", leverage: "2", minNotionalUsd: "10", freeUsdc: "54" });
    expect(p.reasons).toContain("insufficient_margin");
  });
  it("scenarios: a matched full hedge nets roughly zero", () => {
    const p = sizeShield([leg({ mark: "1", sizeStep: "0.0001" })], {
      ratio: "1",
      leverage: "2",
      minNotionalUsd: "10",
      freeUsdc: "1000",
    });
    for (const s of p.scenarios) expect(s.net.abs().lt("0.001")).toBe(true);
  });
  it("property: qty·mark ≤ H ≤ V·β·h", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 30, max: 250 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (v, h, b, m) => {
          const value = new Decimal(v).div(100);
          const ratio = new Decimal(h).div(100);
          const beta = new Decimal(b).div(100);
          const mark = new Decimal(m).div(100);
          const p = sizeShield([leg({ value, beta, mark })], {
            ratio,
            leverage: "2",
            minNotionalUsd: "10",
            freeUsdc: "1e9",
          });
          const l = p.legs[0]!;
          return l.notional.lte(l.targetNotional) && l.targetNotional.lte(value.mul(beta).mul(ratio));
        },
      ),
    );
  });
});

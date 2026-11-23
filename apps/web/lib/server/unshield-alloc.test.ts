import { describe, expect, it } from "vitest";
import { allocateCloses } from "./unshield-alloc";

const sell = (assetId: string, qty: string) => ({ assetId, symbol: assetId, side: "sell", qty, reduceOnly: false, beta: "1" });
const buyClose = (assetId: string, qty: string) => ({ assetId, symbol: assetId, side: "buy", qty, reduceOnly: true });

describe("allocateCloses", () => {
  it("closes each hedge's own legs and leaves the Floor's share of the short", () => {
    const shorts = new Map([["NVDA-P", { size: "5", mark: "100", symbol: "NVDA" }]]);
    // A shield of 2 plus a bell of 1 (with its pre-approved close leg); the other 2 belong to the Floor.
    const r = allocateCloses([{ id: "h1", legs: [sell("NVDA-P", "2")] }, { id: "h2", legs: [sell("NVDA-P", "1"), buyClose("NVDA-P", "1")] }], shorts);
    expect(r.legs.map((l) => [l.hedgeId, l.qty, l.notionalUsd, l.side, l.reduceOnly])).toEqual([
      ["h1", "2", "200.00", "buy", true],
      ["h2", "1", "100.00", "buy", true],
    ]);
    expect(r.emptyHedgeIds).toEqual([]);
  });

  it("caps at the remaining short and reports hedges with nothing left", () => {
    const shorts = new Map([["A", { size: "1.5", mark: "10", symbol: "A" }]]);
    const r = allocateCloses([{ id: "h1", legs: [sell("A", "1")] }, { id: "h2", legs: [sell("A", "1")] }, { id: "h3", legs: [sell("B", "1")] }], shorts);
    expect(r.legs.map((l) => [l.hedgeId, l.qty])).toEqual([["h1", "1"], ["h2", "0.5"]]);
    expect(r.emptyHedgeIds).toEqual(["h3"]);
  });

  it("never emits a sell or a non-reduce-only order", () => {
    const shorts = new Map([["A", { size: "3", mark: "1", symbol: "A" }]]);
    const r = allocateCloses([{ id: "h", legs: [sell("A", "3"), buyClose("A", "3")] }], shorts);
    expect(r.legs.every((l) => l.side === "buy" && l.reduceOnly)).toBe(true);
    expect(r.legs).toHaveLength(1);
  });
});

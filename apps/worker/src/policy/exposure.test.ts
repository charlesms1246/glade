import { describe, expect, it } from "vitest";
import { groupExposure } from "./exposure";

const perps = [
  { asset_id: "p-nvda", symbol: "NVDA" },
  { asset_id: "p-aapl", symbol: "AAPL" },
  { asset_id: "p-sp", symbol: "SP500" },
];
const holdings = [
  { symbol: "NVDAX", value: "400" },
  { symbol: "NVDAC", value: "100" },
  { symbol: "AAPLC", value: "10000" },
];
const positions = [
  { side: "short", asset_id: "p-nvda", size: "2", mark_price: "100" },
  { side: "short", asset_id: "p-aapl", size: "1", mark_price: "50" },
];

describe("groupExposure", () => {
  it("caps a perp against its own symbol group only, with the existing short counted", () => {
    expect(groupExposure({ perpAssetId: "p-nvda", perps, holdings, positions })).toEqual({ holdingValue: "500", existingShortUsd: "200" });
  });
  it("uses the whole stock book for an index perp", () => {
    expect(groupExposure({ perpAssetId: "p-sp", perps, holdings, positions }).holdingValue).toBe("10500");
  });
  it("is zero for a perp with no matching holding", () => {
    expect(groupExposure({ perpAssetId: "p-nvda", perps, holdings: [], positions: [] })).toEqual({ holdingValue: "0", existingShortUsd: "0" });
  });
});

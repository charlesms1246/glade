import { describe, expect, it } from "vitest";
import { heldBellSymbols } from "./watchlist";

describe("heldBellSymbols", () => {
  it("normalises issuer tokens, drops stocks without a perp and de-duplicates", () => {
    expect(heldBellSymbols(["NVDAX", "NVDAC", "AAPLC", "ZZZC"], ["NVDA", "AAPL", "SP500"])).toEqual(["AAPL", "NVDA"]);
  });
  it("is empty with no holdings", () => {
    expect(heldBellSymbols([], ["NVDA"])).toEqual([]);
  });
});

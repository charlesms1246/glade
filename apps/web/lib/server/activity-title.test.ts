import { describe, expect, it } from "vitest";
import { decisionTitle, orderTitle } from "./activity-title";

describe("orderTitle", () => {
  it("describes a dollar-sized buy", () => {
    expect(orderTitle("spot_buy", "25", "quote", "NVDA")).toBe("Buy $25.00 of NVDA");
  });
  it("describes hedge orders in words", () => {
    expect(orderTitle("open", "0.5", "base", "NVDA")).toBe("Open a short hedge: 0.5 NVDA perp");
    expect(orderTitle("close", "0.5", "base", "NVDA")).toBe("Close the hedge: buy back 0.5 NVDA perp");
  });
});

describe("decisionTitle", () => {
  it("maps known actions and humanises the rest", () => {
    expect(decisionTitle("bell_report")).toBe("Bell report");
    expect(decisionTitle("floor_raise_hedge")).toBe("floor raise hedge");
  });
});

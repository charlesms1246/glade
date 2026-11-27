import { describe, expect, it } from "vitest";
import { signedPct, usd } from "./format";

describe("format", () => {
  it("signs percents and rounds tiny values to zero", () => {
    expect(signedPct("0.0123")).toBe("+1.23%");
    expect(signedPct("-0.0123")).toBe("−1.23%");
    expect(signedPct("0.000001")).toBe("0.00%");
  });
  it("puts the minus before the dollar sign", () => {
    expect(usd("-1.23")).toBe("−$1.23");
  });
});

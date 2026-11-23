import { describe, expect, it } from "vitest";
import { clientIp, slidingWindow } from "./rate-limit";

describe("slidingWindow", () => {
  it("allows `limit` hits per window per key, then frees up as hits age out", () => {
    const rl = slidingWindow(5, 3_600_000);
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) expect(rl.allow("1.2.3.4", t0 + i)).toBe(true);
    expect(rl.allow("1.2.3.4", t0 + 10)).toBe(false);
    expect(rl.allow("5.6.7.8", t0 + 10)).toBe(true);
    expect(rl.allow("1.2.3.4", t0 + 3_600_000)).toBe(true);
  });
});

describe("clientIp", () => {
  it("takes the first forwarded address", () => {
    expect(clientIp(new Request("http://x", { headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" } }))).toBe("9.9.9.9");
    expect(clientIp(new Request("http://x"))).toBe("local");
  });
});

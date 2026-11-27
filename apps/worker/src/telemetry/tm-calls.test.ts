import { describe, expect, it } from "vitest";
import { CallCounter, normaliseRoute, statusClass, type CallRow } from "./tm-calls";

const U = "3f2b8c1e-5d4a-4b7e-9c2d-1a2b3c4d5e6f";

describe("normaliseRoute", () => {
  it("drops the query and keeps static paths", () => {
    expect(normaliseRoute("https://api.truemarkets.co/v1/defi/market/prices?symbol=NVDA&asset_class=perp")).toBe("/v1/defi/market/prices");
    expect(normaliseRoute("https://x.co/v1/defi/market/prices/history?symbol=NVDA")).toBe("/v1/defi/market/prices/history");
  });
  it("replaces org, user and order ids", () => {
    expect(normaliseRoute(`https://x.co/v1/account/organizations/${U}/users`)).toBe("/v1/account/organizations/{org}/users");
    expect(normaliseRoute(`https://x.co/v1/gateway/orders/${U}/execute`)).toBe("/v1/gateway/orders/{id}/execute");
    expect(normaliseRoute("https://x.co/v1/gateway/orders/ord_12345")).toBe("/v1/gateway/orders/{id}");
    expect(normaliseRoute(`https://x.co/v1/account/users/${U}/wallets`)).toBe("/v1/account/users/{user}/wallets");
  });
  it("replaces stray uuids and keeps words", () => {
    expect(normaliseRoute(`https://x.co/v1/foo/${U}/bar`)).toBe("/v1/foo/{id}/bar");
    expect(normaliseRoute("https://x.co/v1/gateway/portfolio")).toBe("/v1/gateway/portfolio");
  });
  it("never leaks ids for any uuid placement", () => {
    expect(normaliseRoute(`https://x.co/${U}?a=${U}`)).not.toContain(U);
  });
});

describe("statusClass", () => {
  it("buckets by hundreds", () => {
    expect([200, 201, 404, 429, 503].map(statusClass)).toEqual(["2xx", "2xx", "4xx", "4xx", "5xx"]);
  });
});

describe("CallCounter", () => {
  const at = new Date("2026-11-27T10:00:00Z");
  it("aggregates by day, method, route and class", () => {
    const c = new CallCounter(() => at);
    c.record("get", "https://x.co/v1/gateway/assets?limit=5", 200);
    c.record("GET", "https://x.co/v1/gateway/assets?limit=9", 200);
    c.record("GET", "https://x.co/v1/gateway/assets", 500);
    let rows: CallRow[] = [];
    return c.flush(async (r) => void (rows = r)).then(() => {
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.statusClass === "2xx")).toEqual({ day: "2026-11-27", method: "GET", route: "/v1/gateway/assets", statusClass: "2xx", count: 2 });
    });
  });
  it("does not write when empty and keeps counts after a failed flush", async () => {
    const c = new CallCounter(() => at);
    let calls = 0;
    await c.flush(async () => void calls++);
    expect(calls).toBe(0);
    c.record("GET", "https://x.co/a", 200);
    await expect(c.flush(async () => Promise.reject(new Error("db down")))).rejects.toThrow();
    c.record("GET", "https://x.co/a", 200);
    let rows: CallRow[] = [];
    await c.flush(async (r) => void (rows = r));
    expect(rows[0]?.count).toBe(2);
  });
});

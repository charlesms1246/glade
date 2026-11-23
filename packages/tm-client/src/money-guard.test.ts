import { describe, expect, it } from "vitest";
import { createTmClient } from "./client";
import { assertNoRealMoney, RealMoneyBlockedError } from "./money-guard";
import { TokenManager } from "./token";

const PROD = "https://api.truemarkets.co";
const UAT = "https://api.uat.truemarkets.co";

describe("assertNoRealMoney", () => {
  it.each([
    ["POST", "/v1/gateway/orders"],
    ["POST", "/v1/gateway/orders/o1/execute"],
    ["POST", "/v1/gateway/orders/o1/cancel/execute"],
    ["PATCH", "/v1/gateway/orders/o1"],
    ["POST", "/v1/gateway/transfers"],
    ["POST", "/v1/gateway/transfers/t1/execute"],
    ["POST", "/v1/gateway/ramps"],
    ["POST", "/v1/gateway/custody/releases"],
    ["POST", "/v1/gateway/paper/withdrawals"],
    ["DELETE", "/v1/account/organizations/org/users/u1"],
  ])("blocks %s %s on production", (method, path) => {
    expect(() => assertNoRealMoney(method, `${PROD}${path}`)).toThrow(RealMoneyBlockedError);
  });

  it("allows reads, token mint, user creation and quotes on production", () => {
    expect(() => assertNoRealMoney("GET", `${PROD}/v1/gateway/portfolio`)).not.toThrow();
    expect(() => assertNoRealMoney("POST", `${PROD}/v1/auth/api-key/token`)).not.toThrow();
    expect(() => assertNoRealMoney("POST", `${PROD}/v1/account/organizations/org/users`)).not.toThrow();
    expect(() => assertNoRealMoney("POST", `${PROD}/v1/gateway/quotes`)).not.toThrow();
  });

  it("does not restrict UAT (paper funds)", () => {
    expect(() => assertNoRealMoney("POST", `${UAT}/v1/gateway/orders`)).not.toThrow();
  });
});

describe("client against production", () => {
  it("throws before any network call when creating an order", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response("{}", { status: 201 });
    }) as typeof fetch;
    const tokens = new TokenManager(async () => ({ accessToken: "a.e30.b", expiresAt: Infinity, claims: { organizationId: "o", role: undefined } }));
    const tm = createTmClient({ restBase: PROD, tokens, fetch: fetchFn });
    await expect(
      tm.forUser("u").createOrder({ asset_id: "a", side: "sell", type: "market", qty: "1", qty_unit: "base", venue: "defi" }),
    ).rejects.toBeInstanceOf(RealMoneyBlockedError);
    await expect(tm.forUser("u").executeOrder("o1", ["sig"])).rejects.toBeInstanceOf(RealMoneyBlockedError);
    expect(calls).toBe(0);
  });
});

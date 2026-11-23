import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { mandateCheck, mandateHash, type CheckContext, type CheckIntent, type MandateTerms } from "./mandate";

const ctx: CheckContext = {
  env: "uat",
  allowProd: false,
  maxOrderUsd: "20",
  mandate: { status: "active", allowedPerps: ["p-sp500"], leverageMax: "3", maxTradesDay: 10 },
  assertion: null,
  tradesToday: 0,
  riskyValue: "100",
  beta: "1",
  userLeverageCap: "3",
};
const short: CheckIntent = {
  kind: "open",
  side: "sell",
  assetId: "p-sp500",
  instrument: "perp",
  reduceOnly: false,
  leverage: "2",
  notionalUsd: "15",
  source: "automation",
  planHash: null,
};

describe("mandateCheck (automation)", () => {
  it("allows a short within the mandate", () => {
    expect(mandateCheck(short, ctx)).toEqual({ ok: true });
  });
  it("allows a reduce-only buy", () => {
    expect(mandateCheck({ ...short, kind: "decrease", side: "buy", reduceOnly: true, leverage: null }, ctx).ok).toBe(true);
  });
  it("never opens a long perp", () => {
    expect(mandateCheck({ ...short, side: "buy" }, ctx).ok).toBe(false);
  });
  it("never trades spot or transfers", () => {
    expect(mandateCheck({ ...short, kind: "spot_buy", side: "buy", instrument: "spot" }, ctx).ok).toBe(false);
    expect(mandateCheck({ ...short, kind: "transfer", instrument: "transfer" }, ctx).ok).toBe(false);
  });
  it("enforces mandate status, instrument, leverage, notional and trade cap", () => {
    expect(mandateCheck(short, { ...ctx, mandate: { ...ctx.mandate!, status: "revoked" } }).ok).toBe(false);
    expect(mandateCheck({ ...short, assetId: "p-other" }, ctx).ok).toBe(false);
    expect(mandateCheck({ ...short, leverage: "4" }, ctx).ok).toBe(false);
    expect(mandateCheck({ ...short, notionalUsd: "106" }, ctx).ok).toBe(false);
    expect(mandateCheck(short, { ...ctx, tradesToday: 10 }).ok).toBe(false);
  });
  it("prod requires ALLOW_PROD and the order cap", () => {
    expect(mandateCheck(short, { ...ctx, env: "prod" }).ok).toBe(false);
    expect(mandateCheck(short, { ...ctx, env: "prod", allowProd: true }).ok).toBe(true);
    expect(mandateCheck({ ...short, notionalUsd: "21" }, { ...ctx, env: "prod", allowProd: true }).ok).toBe(false);
  });
  it("property: a non-reduce-only buy on a perp is always rejected", () => {
    fc.assert(
      fc.property(fc.constantFrom("automation", "user"), fc.integer({ min: 1, max: 1000 }), (source, n) => {
        const r = mandateCheck(
          { ...short, side: "buy", reduceOnly: false, source: source as "automation" | "user", planHash: "h", notionalUsd: String(n) },
          { ...ctx, assertion: { planHash: "h", approvedAssetIds: ["p-sp500"] } },
        );
        return !r.ok;
      }),
    );
  });
});

describe("mandateCheck (user-approved)", () => {
  const userCtx = { ...ctx, mandate: null, assertion: { planHash: "abc", approvedAssetIds: ["p-sp500", "s-nvda"] } };
  it("requires a matching plan hash", () => {
    expect(mandateCheck({ ...short, source: "user", planHash: "abc" }, userCtx).ok).toBe(true);
    expect(mandateCheck({ ...short, source: "user", planHash: "zzz" }, userCtx).ok).toBe(false);
  });
  it("allows an approved spot buy", () => {
    const spot: CheckIntent = { ...short, source: "user", planHash: "abc", kind: "spot_buy", side: "buy", instrument: "spot", assetId: "s-nvda", leverage: null };
    expect(mandateCheck(spot, userCtx).ok).toBe(true);
    expect(mandateCheck({ ...spot, assetId: "s-other" }, userCtx).ok).toBe(false);
  });
});

describe("mandateHash", () => {
  const terms: MandateTerms = {
    userId: "u1",
    version: 1,
    floorPct: "0.85",
    multiplier: "4",
    ratchet: true,
    baseUsd: "100",
    leverageMax: "3",
    allowedPerps: ["b", "a"],
    maxTradesDay: 10,
  };
  it("is stable across key and list order", () => {
    const reordered: MandateTerms = {
      maxTradesDay: 10,
      allowedPerps: ["a", "b"],
      userId: "u1",
      version: 1,
      floorPct: "0.85",
      multiplier: "4",
      ratchet: true,
      baseUsd: "100",
      leverageMax: "3",
    };
    expect(mandateHash(reordered)).toBe(mandateHash(terms));
    expect(mandateHash(terms)).toMatch(/^[0-9a-f]{64}$/);
  });
  it("changes when terms change", () => {
    expect(mandateHash({ ...terms, floorPct: "0.9" })).not.toBe(mandateHash(terms));
  });
});

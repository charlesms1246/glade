import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { mandateCheck, mandateHash, type CheckContext, type CheckIntent, type MandateTerms } from "./mandate";

const ctx: CheckContext = {
  env: "uat",
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
  it("always refuses production and enforces the order cap", () => {
    expect(mandateCheck(short, { ...ctx, env: "prod" })).toEqual({ ok: false, reasons: ["production orders are never placed (no real money)"] });
    expect(mandateCheck(short, ctx).ok).toBe(true);
    expect(mandateCheck({ ...short, notionalUsd: "21" }, ctx).ok).toBe(false);
  });
  it("allows paper execution under the same rules", () => {
    expect(mandateCheck(short, { ...ctx, env: "paper" }).ok).toBe(true);
    expect(mandateCheck({ ...short, notionalUsd: "21" }, { ...ctx, env: "paper" }).ok).toBe(false);
  });
  it("property: no intent of any kind passes in production", () => {
    fc.assert(
      fc.property(fc.constantFrom("automation", "user"), fc.constantFrom("sell", "buy"), fc.boolean(), (source, side, reduceOnly) =>
        !mandateCheck({ ...short, source, side, reduceOnly } as typeof short, { ...ctx, env: "prod" }).ok,
      ),
    );
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

describe("mandateCheck cumulative cap and wind-down", () => {
  it("counts the short already open against the cap", () => {
    const c = { ...ctx, hedgeableValue: "100", existingShortUsd: "95", maxOrderUsd: "1000" };
    expect(mandateCheck({ ...short, notionalUsd: "10" }, c)).toEqual({ ok: true });
    expect(mandateCheck({ ...short, notionalUsd: "11" }, c).ok).toBe(false);
  });
  it("uses the group value, not the whole portfolio, when given", () => {
    const c = { ...ctx, riskyValue: "20000", hedgeableValue: "10", maxOrderUsd: "100000" };
    expect(mandateCheck({ ...short, notionalUsd: "10500" }, c).ok).toBe(false);
  });
  it("never blocks reduce-only buys on the cap", () => {
    const c = { ...ctx, hedgeableValue: "0", existingShortUsd: "500" };
    expect(mandateCheck({ ...short, kind: "decrease", side: "buy", reduceOnly: true, leverage: null }, c).ok).toBe(true);
  });
  it("property: existing + new above 1.05 x holding x beta is refused", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1000 }), fc.integer({ min: 0, max: 1000 }), fc.integer({ min: 1, max: 1000 }), (hold, ex, n) => {
        const c = { ...ctx, hedgeableValue: String(hold), existingShortUsd: String(ex), maxOrderUsd: "1000000" };
        const r = mandateCheck({ ...short, notionalUsd: String(n) }, c).ok;
        return r === (n + ex <= 1.05 * hold + 1e-9);
      }),
    );
  });
  const close = { ...short, kind: "close" as const, side: "buy" as const, reduceOnly: true, leverage: null, qty: "0.5", notionalUsd: "5" };
  it("lets a revoked or paused mandate wind down only the owned size, reduce-only", () => {
    const revoked = { ...ctx, mandate: { ...ctx.mandate!, status: "revoked" as const }, ownedShortQty: "0.5" };
    expect(mandateCheck(close, revoked)).toEqual({ ok: true });
    expect(mandateCheck(close, { ...revoked, mandate: null }).ok).toBe(true);
    expect(mandateCheck({ ...close, qty: "0.6" }, revoked).ok).toBe(false);
    expect(mandateCheck(close, { ...revoked, ownedShortQty: undefined }).ok).toBe(false);
    expect(mandateCheck({ ...close, side: "sell", reduceOnly: false, qty: "0.5" }, revoked).ok).toBe(false);
    expect(mandateCheck(close, { ...revoked, env: "prod" }).ok).toBe(false);
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

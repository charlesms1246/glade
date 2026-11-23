import { dec } from "@glade/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyFill, applyFunding, emptyState, liquidationPrice, positionView, type OrderSpec } from "./core";
import type { PaperAsset, PaperState } from "./types";

const perp: PaperAsset = { assetId: "p1", symbol: "NVDA", type: "perp", assetClass: "stock", maxLeverage: 5, economicAssetId: null, venue: "hyperliquid", chain: "hypercore-perp" };
const spot: PaperAsset = { assetId: "s1", symbol: "NVDAx", type: "spot", assetClass: "stock", maxLeverage: null, economicAssetId: "e1", venue: "defi", chain: "solana" };
const funded = (usd: string): PaperState => ({ ...emptyState(), cashUsd: usd });
const sell = (qty: string, leverage: number | null = 2): OrderSpec => ({ side: "sell", qty, qtyUnit: "base", leverage, reduceOnly: false });
const close = (qty: string): OrderSpec => ({ side: "buy", qty, qtyUnit: "base", leverage: null, reduceOnly: true });

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
}

describe("perp fills", () => {
  it("opens a short with notional/leverage margin and a 4.5 bp fee", () => {
    const r = ok(applyFill(funded("1000"), perp, sell("1"), dec("100")));
    expect(r.state.positions.p1).toEqual({ assetId: "p1", size: "1", entryPrice: "100", margin: "50", leverage: 2 });
    expect(r.fill).toEqual({ qty: "1", vwap: "100", fee: "0.045" });
    expect(r.state.cashUsd).toBe("949.955");
  });

  it("increases at a weighted entry and keeps the position's leverage", () => {
    const a = ok(applyFill(funded("1000"), perp, sell("1"), dec("100")));
    const b = ok(applyFill(a.state, perp, sell("1", 3), dec("200")));
    expect(b.state.positions.p1).toMatchObject({ size: "2", entryPrice: "150", margin: "150", leverage: 2 });
  });

  it("closes with realised pnl and releases margin", () => {
    const a = ok(applyFill(funded("1000"), perp, sell("2"), dec("100")));
    const b = ok(applyFill(a.state, perp, close("1"), dec("90")));
    expect(b.state.positions.p1).toMatchObject({ size: "1", margin: "50" });
    // 899.91 (after open) + 50 released + 10 pnl − 0.0405 fee
    expect(b.state.cashUsd).toBe("959.8695");
    const c = ok(applyFill(b.state, perp, close("1"), dec("90")));
    expect(c.state.positions.p1).toBeUndefined();
  });

  it("caps a closed loss at the margin it releases", () => {
    const a = ok(applyFill(funded("100"), perp, sell("1"), dec("100")));
    const b = ok(applyFill(a.state, perp, close("1"), dec("500")));
    expect(b.ledger.find((l) => l.kind === "realized_pnl")!.amountUsd).toBe("-50");
    expect(dec(b.state.cashUsd).gte(0)).toBe(true);
  });

  it("refuses long opens, reduce-only flips, missing positions and bad leverage", () => {
    const a = ok(applyFill(funded("1000"), perp, sell("1"), dec("100")));
    expect(applyFill(a.state, perp, { ...close("1"), reduceOnly: false }, dec("100"))).toEqual({ ok: false, reason: "long_perp_not_allowed" });
    expect(applyFill(a.state, perp, close("1.5"), dec("100"))).toEqual({ ok: false, reason: "reduce_only_would_flip" });
    expect(applyFill(funded("1000"), perp, close("1"), dec("100"))).toEqual({ ok: false, reason: "no_position" });
    expect(applyFill(funded("1000"), perp, { ...sell("1"), reduceOnly: true }, dec("100"))).toEqual({ ok: false, reason: "reduce_only_sell_not_allowed" });
    expect(applyFill(funded("1000"), perp, sell("1", null), dec("100"))).toEqual({ ok: false, reason: "leverage_required" });
    expect(applyFill(funded("1000"), perp, sell("1", 6), dec("100"))).toEqual({ ok: false, reason: "leverage_out_of_range" });
  });

  it("reports insufficient balance when margin plus fee exceeds cash", () => {
    expect(applyFill(funded("50"), perp, sell("1"), dec("100"))).toEqual({ ok: false, reason: "insufficient_balance" });
  });

  it("puts a 2x short's liquidation at entry·(1 + 1/2 − 1/(2·max))", () => {
    const r = ok(applyFill(funded("1000"), perp, sell("1"), dec("100")));
    expect(liquidationPrice(r.state.positions.p1!, perp).toString()).toBe("140");
    const v = positionView(r.state.positions.p1!, perp, dec("110"));
    expect(v).toMatchObject({ side: "short", unrealized_pnl: "-10", mark_price: "110", margin_used: "50", leverage: 2 });
  });
});

describe("spot fills", () => {
  it("spends exactly the quote amount, fee included", () => {
    const r = ok(applyFill(funded("1000"), spot, { side: "buy", qty: "100.1", qtyUnit: "quote", leverage: null, reduceOnly: false }, dec("10")));
    expect(r.state.cashUsd).toBe("899.9");
    expect(r.state.holdings.s1).toBe("10");
    expect(r.fill.fee).toBe("0.1");
  });

  it("sells holdings for proceeds minus 10 bp", () => {
    const s: PaperState = { ...funded("0"), holdings: { s1: "10" } };
    const r = ok(applyFill(s, spot, { side: "sell", qty: "10", qtyUnit: "base", leverage: null, reduceOnly: false }, dec("10")));
    expect(r.state.cashUsd).toBe("99.9");
    expect(r.state.holdings.s1).toBeUndefined();
    expect(applyFill(s, spot, { side: "sell", qty: "11", qtyUnit: "base", leverage: null, reduceOnly: false }, dec("10"))).toEqual({ ok: false, reason: "insufficient_balance" });
  });
});

describe("funding", () => {
  it("credits shorts on a positive rate into margin, once per hour", () => {
    const a = ok(applyFill(funded("1000"), perp, sell("1"), dec("100")));
    const r = applyFunding(a.state, 10, { p1: { rate: dec("0.0001"), mark: dec("100") } });
    expect(r.state.positions.p1!.margin).toBe("50.01");
    expect(r.ledger).toHaveLength(1);
    const again = applyFunding(r.state, 10, { p1: { rate: dec("0.0001"), mark: dec("100") } });
    expect(again.state).toBe(r.state);
    expect(again.ledger).toEqual([]);
  });

  it("never takes margin below zero", () => {
    const a = ok(applyFill(funded("1000"), perp, sell("1"), dec("100")));
    const r = applyFunding(a.state, 1, { p1: { rate: dec("-1"), mark: dec("100") } });
    expect(r.state.positions.p1!.margin).toBe("0");
  });
});

describe("properties", () => {
  const px = fc.integer({ min: 1, max: 100_000 }).map((n) => dec(n).div(100));
  const qty = fc.integer({ min: 1, max: 10_000 }).map((n) => dec(n).div(1000).toFixed());
  const lev = fc.integer({ min: 1, max: 5 });

  it("cash never goes negative, and ledger sums equal the cash change", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.boolean(), qty, px, lev), { maxLength: 20 }), (steps) => {
        let s = funded("10000");
        for (const [isOpen, q, p, l] of steps) {
          const r = applyFill(s, perp, isOpen ? sell(q, l) : close(q), p);
          if (!r.ok) continue;
          const delta = r.ledger.reduce((acc, e) => acc.plus(e.amountUsd), dec(0));
          // fx() rounds each value toward zero at 18 dp, so allow dust.
          expect(dec(r.state.cashUsd).minus(s.cashUsd).minus(delta).abs().lte("1e-15")).toBe(true);
          expect(dec(r.state.cashUsd).gte(0)).toBe(true);
          s = r.state;
        }
      }),
    );
  });

  it("open then close at the same price costs exactly the two fees", () => {
    fc.assert(
      fc.property(qty, px, lev, (q, p, l) => {
        const a = applyFill(funded("1000000"), perp, sell(q, l), p);
        if (!a.ok) return;
        const b = ok(applyFill(a.state, perp, close(q), p));
        const fees = dec(a.fill.fee).plus(b.fill.fee);
        expect(dec("1000000").minus(b.state.cashUsd).minus(fees).abs().lte("1e-15")).toBe(true);
        expect(b.state.positions.p1).toBeUndefined();
      }),
    );
  });
});

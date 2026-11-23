import { dec } from "@glade/shared";
import { generateSignerKeyPair, stampPayload } from "@glade/stamp";
import { TmApiError } from "@glade/tm-client";
import { describe, expect, it } from "vitest";
import { memoryPaperRepo } from "./memory-repo";
import type { PaperAsset } from "./types";
import { createPaperVenue } from "./venue";

const assets: Record<string, PaperAsset> = {
  p1: { assetId: "p1", symbol: "NVDA", type: "perp", assetClass: "stock", maxLeverage: 5, economicAssetId: null, venue: "hyperliquid", chain: "hypercore-perp" },
  s1: { assetId: "s1", symbol: "NVDAx", type: "spot", assetClass: "stock", maxLeverage: null, economicAssetId: "e1", venue: "defi", chain: "solana" },
};

function setup() {
  const signer = generateSignerKeyPair();
  const mem = memoryPaperRepo({ u1: signer.publicKeyHex });
  let t = 1_000_000;
  const px: Record<string, string> = { "NVDA:perp": "100", "NVDAx:spot": "10" };
  const venue = createPaperVenue({
    repo: mem.repo,
    prices: async (symbol, cls) => dec(px[`${symbol}:${cls}`]!),
    registry: async (id) => assets[id] ?? null,
    now: () => t,
  });
  return { venue, mem, signer, px, user: venue.forUser("u1"), tick: (ms: number) => (t += ms) };
}

const short = { asset_id: "p1", side: "sell", type: "market", qty: "1", qty_unit: "base", leverage: 2, venue: "defi" } as const;

async function rejects(p: Promise<unknown>, status: number, code: string) {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(TmApiError);
  expect(e).toMatchObject({ status, code });
}

describe("paper venue", () => {
  it("quotes one canonical payload, verifies the real stamp and fills at the execution price", async () => {
    const h = setup();
    await h.venue.fundPaper("u1", "1000");
    const o = await h.user.createOrder(short);
    expect(o.order_id).toMatch(/^paper_/);
    expect(o.status).toBe("initialized");
    expect(o.payloads).toHaveLength(1);
    expect(o.payloads![0]!.payload.endsWith("}\n")).toBe(true);
    h.px["NVDA:perp"] = "101";
    await h.user.executeOrder(o.order_id!, [stampPayload(o.payloads![0]!.payload, h.signer)]);
    expect(await h.user.getOrder(o.order_id!)).toMatchObject({ status: "complete", executed_qty: "1", executed_vwap: "101", asset_type: "perp" });
    const { positions } = await h.user.positions();
    expect(positions[0]).toMatchObject({ side: "short", size: "1", entry_price: "101", margin_used: "50.5", leverage: 2 });
  });

  it("rejects a stamp from another key or over another payload", async () => {
    const h = setup();
    await h.venue.fundPaper("u1", "1000");
    const o = await h.user.createOrder(short);
    await rejects(h.user.executeOrder(o.order_id!, [stampPayload(o.payloads![0]!.payload, generateSignerKeyPair())]), 401, "invalid_signature");
    await rejects(h.user.executeOrder(o.order_id!, [stampPayload(o.payloads![0]!.payload.trimEnd(), h.signer)]), 401, "invalid_signature");
    await rejects(h.user.executeOrder(o.order_id!, ["garbage"]), 401, "invalid_signature");
  });

  it("answers a second execute with 409 already_submitted", async () => {
    const h = setup();
    await h.venue.fundPaper("u1", "1000");
    const o = await h.user.createOrder(short);
    const sig = stampPayload(o.payloads![0]!.payload, h.signer);
    await h.user.executeOrder(o.order_id!, [sig]);
    await rejects(h.user.executeOrder(o.order_id!, [sig]), 409, "already_submitted");
    expect((await h.user.positions()).positions[0]!.size).toBe("1");
  });

  it("expires quotes after 120 s with 422 quote_stale", async () => {
    const h = setup();
    await h.venue.fundPaper("u1", "1000");
    const o = await h.user.createOrder(short);
    h.tick(120_001);
    await rejects(h.user.executeOrder(o.order_id!, [stampPayload(o.payloads![0]!.payload, h.signer)]), 422, "quote_stale");
    expect(await h.user.getOrder(o.order_id!)).toMatchObject({ status: "failed", failure_reason: "quote_stale" });
    expect((await h.user.positions()).positions).toEqual([]);
  });

  it("returns an empty order_id with insufficient_balance issues", async () => {
    const h = setup();
    expect(await h.user.createOrder(short)).toEqual({ order_id: "", quote: { issues: ["insufficient_balance"] } });
  });

  it("refuses long perp opens", async () => {
    const h = setup();
    await h.venue.fundPaper("u1", "1000");
    await rejects(h.user.createOrder({ ...short, side: "buy" }), 400, "long_perp_not_allowed");
  });

  it("reports spot holdings and positions in the portfolio", async () => {
    const h = setup();
    await h.venue.fundPaper("u1", "1000");
    const buy = await h.user.createOrder({ asset_id: "s1", side: "buy", type: "market", qty: "100.1", qty_unit: "quote", venue: "defi" });
    await h.user.executeOrder(buy.order_id!, [stampPayload(buy.payloads![0]!.payload, h.signer)]);
    const sh = await h.user.createOrder(short);
    await h.user.executeOrder(sh.order_id!, [stampPayload(sh.payloads![0]!.payload, h.signer)]);
    h.px["NVDA:perp"] = "90";
    const p = await h.user.portfolio();
    // cash 1000 − 100.1 − 50 − 0.045; NVDAx 10 × 10; short margin 50 + upnl 10
    expect(p.cash_usd).toBe("849.855");
    expect(p.total_usd).toBe("1009.855");
    expect(p.balances.map((b) => [b.symbol, b.total])).toEqual([["USDC", "849.855"], ["NVDAx", "10"]]);
    expect(p.balances[1]).toMatchObject({ economic_asset_id: "e1", value: "100", stable: false });
    expect(p.positions[0]).toMatchObject({ unrealized_pnl: "10", mark_price: "90" });
  });

  it("creates a paper account once, whatever the retries", async () => {
    const h = setup();
    expect(await Promise.all([h.venue.ensurePaperAccount("u1", "10000"), h.venue.ensurePaperAccount("u1", "10000")])).toEqual([true, false]);
    expect(await h.venue.ensurePaperAccount("u1", "10000")).toBe(false);
    expect((await h.user.portfolio()).cash_usd).toBe("10000");
    expect(h.mem.ledger.filter((l) => l.kind === "deposit")).toHaveLength(1);
  });

  it("accrues funding at most once per hour", async () => {
    const h = setup();
    await h.venue.fundPaper("u1", "1000");
    const o = await h.user.createOrder(short);
    await h.user.executeOrder(o.order_id!, [stampPayload(o.payloads![0]!.payload, h.signer)]);
    const at = 7_200_000;
    expect(await h.venue.accrueFunding("u1", { NVDA: "0.0001" }, at)).toHaveLength(1);
    expect(await h.venue.accrueFunding("u1", { NVDA: "0.0001" }, at + 1000)).toEqual([]);
    expect((await h.user.positions()).positions[0]!.margin_used).toBe("50.01");
  });

  it("cancels an initialized order and refuses to execute it afterwards", async () => {
    const h = setup();
    await h.venue.fundPaper("u1", "1000");
    const o = await h.user.createOrder(short);
    expect(await h.user.cancelOrder(o.order_id!)).toMatchObject({ status: "canceled", payloads: [] });
    await rejects(h.user.executeOrder(o.order_id!, [stampPayload(o.payloads![0]!.payload, h.signer)]), 409, "already_submitted");
  });

  it("hides other users' orders", async () => {
    const h = setup();
    await h.venue.fundPaper("u1", "1000");
    const o = await h.user.createOrder(short);
    await rejects(h.venue.forUser("u2").getOrder(o.order_id!), 404, "order_not_found");
  });
});

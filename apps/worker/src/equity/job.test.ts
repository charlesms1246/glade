import { createPaperVenue, memoryPaperRepo, type PaperAsset } from "@glade/paper";
import { dec } from "@glade/shared";
import { generateSignerKeyPair, stampPayload } from "@glade/stamp";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { bucketStart, floorValue, runEquityJob, type EquitySnapshot, type FloorTerms } from "./job";

const assets: Record<string, PaperAsset> = {
  p1: { assetId: "p1", symbol: "NVDA", type: "perp", assetClass: "stock", maxLeverage: 5, economicAssetId: null, venue: "hyperliquid", chain: null },
  s1: { assetId: "s1", symbol: "NVDAx", type: "spot", assetClass: "stock", maxLeverage: null, economicAssetId: "e1", venue: "defi", chain: "solana" },
};

async function paperUser() {
  const signer = generateSignerKeyPair();
  const venue = createPaperVenue({
    repo: memoryPaperRepo({ u1: signer.publicKeyHex }).repo,
    prices: async (_s, cls) => dec(cls === "perp" ? "90" : "10"),
    registry: async (id) => assets[id] ?? null,
    now: () => 0,
  });
  await venue.fundPaper("u1", "1000");
  const u = venue.forUser("u1");
  for (const body of [
    { asset_id: "s1", side: "buy", type: "market", qty: "100.1", qty_unit: "quote", venue: "defi" },
    { asset_id: "p1", side: "sell", type: "market", qty: "1", qty_unit: "base", leverage: 2, venue: "defi" },
  ] as const) {
    const o = await u.createOrder(body);
    await u.executeOrder(o.order_id!, [stampPayload(o.payloads![0]!.payload, signer)]);
  }
  return u;
}

const terms: FloorTerms = { floorPct: "0.85", ratchet: true, baseUsd: "1000", peakUsd: "1100" };

describe("floorValue", () => {
  it("matches the Floor loop: ratchet uses max(peak, equity), otherwise the base", () => {
    expect(floorValue(terms, dec("1050")).toString()).toBe("935");
    expect(floorValue(terms, dec("1200")).toString()).toBe("1020");
    expect(floorValue({ ...terms, peakUsd: null }, dec("900")).toString()).toBe("850");
    expect(floorValue({ ...terms, ratchet: false }, dec("1200")).toString()).toBe("850");
  });

  it("property: a ratcheting floor never sits below the fixed one", () => {
    const amt = fc.integer({ min: 1, max: 10_000_000 }).map((n) => dec(n).div(100));
    fc.assert(
      fc.property(amt, amt, fc.option(amt, { nil: null }), (base, equity, peak) => {
        const t = { floorPct: "0.9", baseUsd: base.toFixed(), peakUsd: peak?.toFixed() ?? null };
        expect(floorValue({ ...t, ratchet: true }, equity).gte(floorValue({ ...t, ratchet: false }, equity)) || (peak !== null && peak.lt(base))).toBe(true);
      }),
    );
  });
});

describe("equity snapshot job", () => {
  it("stores paper totals with stock value, hedge notional and the floor, in a 15-minute bucket", async () => {
    const u = await paperUser();
    const saved: EquitySnapshot[] = [];
    const now = new Date("2026-11-24T15:07:31Z");
    const r = await runEquityJob({ users: async () => ["u1"], portfolio: () => u.portfolio(), floorTerms: async () => terms, save: async (s) => void saved.push(s) }, now);
    expect(r).toEqual({ saved: ["u1"], failed: [] });
    // cash 1000 − 100.1 − 45 margin − 0.0405 fee; NVDAx 10 × 10; short margin 45, mark 90 = entry → upnl 0
    expect(saved[0]).toEqual({
      userId: "u1",
      at: new Date("2026-11-24T15:00:00Z"),
      equityUsd: "999.8595",
      stockUsd: "100",
      hedgeNotionalUsd: "90",
      floorUsd: "935",
    });
  });

  it("omits the floor without an active mandate, and keeps going when one user fails", async () => {
    const u = await paperUser();
    const saved: EquitySnapshot[] = [];
    const logs: string[] = [];
    const r = await runEquityJob(
      {
        users: async () => ["bad", "u1"],
        portfolio: async (id) => (id === "bad" ? Promise.reject(new Error("no price")) : u.portfolio()),
        floorTerms: async () => null,
        save: async (s) => void saved.push(s),
        log: (e) => void logs.push(e),
      },
      new Date(),
    );
    expect(r).toEqual({ saved: ["u1"], failed: ["bad"] });
    expect(saved[0]!.floorUsd).toBeNull();
    expect(logs).toEqual(["equity_snapshot_failed"]);
  });

  it("buckets every time within a quarter hour to the same start", () => {
    expect(bucketStart(new Date("2026-11-24T15:14:59.999Z")).toISOString()).toBe("2026-11-24T15:00:00.000Z");
    expect(bucketStart(new Date("2026-11-24T15:15:00Z")).toISOString()).toBe("2026-11-24T15:15:00.000Z");
  });
});

describe("equity job work list", () => {
  it("asks for users missing the current bucket", async () => {
    const asked: Date[] = [];
    await runEquityJob({ users: async (at) => (asked.push(at), []), portfolio: async () => ({}) as never, floorTerms: async () => null, save: async () => {} }, new Date("2026-11-24T15:07:00Z"));
    expect(asked[0]!.toISOString()).toBe("2026-11-24T15:00:00.000Z");
  });
});

import { createPaperVenue, memoryPaperRepo, type PaperAsset } from "@glade/paper";
import { dec } from "@glade/shared";
import { generateSignerKeyPair, stampPayload } from "@glade/stamp";
import type { AssetItem } from "@glade/tm-client";
import { describe, expect, it } from "vitest";
import { ratesFromAssets, runFundingJob } from "./job";

const perp: PaperAsset = { assetId: "p1", symbol: "NVDA", type: "perp", assetClass: "stock", maxLeverage: 5, economicAssetId: null, venue: "hyperliquid", chain: null };

async function shortUser() {
  const signer = generateSignerKeyPair();
  const mem = memoryPaperRepo({ u1: signer.publicKeyHex });
  const venue = createPaperVenue({ repo: mem.repo, prices: async () => dec("100"), registry: async (id) => (id === "p1" ? perp : null), now: () => 0 });
  await venue.fundPaper("u1", "1000");
  const u = venue.forUser("u1");
  const o = await u.createOrder({ asset_id: "p1", side: "sell", type: "market", qty: "1", qty_unit: "base", leverage: 2, venue: "defi" });
  await u.executeOrder(o.order_id!, [stampPayload(o.payloads![0]!.payload, signer)]);
  return { venue, mem, u };
}

describe("funding job", () => {
  it("reads hourly perp rates by symbol from the asset list", () => {
    const assets = [
      { symbol: "NVDA", type: "perp", perp: { funding_rate: "0.0000125" }, order_types: [] },
      { symbol: "NVDAx", type: "spot", order_types: [] },
      { symbol: "AAPL", type: "perp", perp: { funding_rate: null }, order_types: [] },
    ] as AssetItem[];
    expect(ratesFromAssets(assets)).toEqual({ NVDA: "0.0000125" });
  });

  it("credits shorts once per hour, however often it runs", async () => {
    const { venue, u } = await shortUser();
    const deps = { users: async () => ["u1"], hourlyRates: async () => ({ NVDA: "0.0001" }), accrue: venue.accrueFunding };
    const at = new Date("2026-11-24T15:05:00Z");
    expect(await runFundingJob(deps, at)).toEqual({ credited: ["u1"], unchanged: [] });
    expect(await runFundingJob(deps, new Date("2026-11-24T15:55:00Z"))).toEqual({ credited: [], unchanged: ["u1"] });
    expect((await u.positions()).positions[0]!.margin_used).toBe("50.01");
    expect(await runFundingJob(deps, new Date("2026-11-24T16:00:00Z"))).toEqual({ credited: ["u1"], unchanged: [] });
  });

  it("skips the rate fetch when nobody holds a position, and survives a failing user", async () => {
    let fetched = 0;
    const none = await runFundingJob({ users: async () => [], hourlyRates: async () => (fetched++, {}), accrue: async () => [] }, new Date());
    expect(none).toEqual({ credited: [], unchanged: [] });
    expect(fetched).toBe(0);
    const logs: string[] = [];
    const r = await runFundingJob(
      { users: async () => ["bad", "ok"], hourlyRates: async () => ({ NVDA: "0.0001" }), accrue: async (id) => { if (id === "bad") throw new Error("x"); return [{}]; }, log: (e) => void logs.push(e) },
      new Date(),
    );
    expect(r).toEqual({ credited: ["ok"], unchanged: [] });
    expect(logs).toEqual(["funding_user_failed"]);
  });
});

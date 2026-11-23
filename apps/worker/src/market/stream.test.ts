import { describe, expect, it } from "vitest";
import { PriceCache } from "./price-cache";
import { MarketStream, topicFor } from "./stream";

function fakeSocket() {
  const sent: string[] = [];
  const s = { onopen: null, onmessage: null, onclose: null, onerror: null, send: (d: string) => void sent.push(d), close: () => {} } as {
    onopen: (() => void) | null;
    onmessage: ((e: { data: unknown }) => void) | null;
    onclose: (() => void) | null;
    onerror: ((e: unknown) => void) | null;
    send(d: string): void;
    close(): void;
  };
  return { s, sent };
}

describe("MarketStream", () => {
  it("builds perp topics with the -PERP suffix", () => {
    expect(topicFor({ symbol: "nvda", cls: "perp" })).toBe("price.NVDA-PERP");
    expect(topicFor({ symbol: "NVDA", cls: "spot" })).toBe("price.NVDA");
  });

  it("subscribes watched topics on open and caches price ticks", () => {
    const cache = new PriceCache();
    const f = fakeSocket();
    const m = new MarketStream({ url: "wss://x", cache, tm: { prices: async () => ({}) }, makeSocket: () => f.s });
    m.watch([{ symbol: "NVDA", cls: "spot" }, { symbol: "NVDA", cls: "perp" }]);
    m.start();
    f.s.onopen!();
    expect(JSON.parse(f.sent[0]!)).toEqual({ type: "subscribe", topics: ["price.NVDA", "price.NVDA-PERP"] });
    f.s.onmessage!({
      data: JSON.stringify({ type: "price", topics: ["price.NVDA-PERP"], data: { symbol: "NVDA", asset_class: "perp", price: "164.65", timestamp: "2026-11-23T18:37:14Z" } }),
    });
    expect(cache.get("NVDA", "perp")?.px.toString()).toBe("164.65");
    f.s.onmessage!({ data: "not json" });
    f.s.onmessage!({ data: JSON.stringify({ type: "subscribe", status: "success" }) });
  });

  it("ignores out-of-order ticks", () => {
    const cache = new PriceCache();
    cache.set("NVDA", "spot", "2", new Date("2026-11-23T18:00:02Z"), "ws");
    cache.set("NVDA", "spot", "1", new Date("2026-11-23T18:00:01Z"), "ws");
    expect(cache.get("NVDA", "spot")?.px.toString()).toBe("2");
  });

  it("falls back to REST for stale instruments only", async () => {
    const cache = new PriceCache();
    const now = new Date("2026-11-23T18:01:00Z");
    cache.set("NVDA", "spot", "160", new Date("2026-11-23T18:00:50Z"), "ws");
    const asked: string[] = [];
    const m = new MarketStream({
      url: "wss://x",
      cache,
      now: () => now,
      tm: { prices: async (sym: string, cls?: "spot" | "perp") => (asked.push(`${sym}:${cls}`), { candles: [{ interval: "1h", closePrice: "7250.5" }] }) },
      makeSocket: () => fakeSocket().s,
    });
    m.watch([{ symbol: "NVDA", cls: "spot" }, { symbol: "SP500", cls: "perp" }]);
    expect(await m.refreshStale()).toBe(1);
    expect(asked).toEqual(["SP500:perp"]);
    expect(cache.get("SP500", "perp")).toMatchObject({ source: "rest" });
  });
});

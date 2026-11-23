// Spike: public market data reads (no auth, no orders). Confirms history formats for beta, replay and Bell.
//   pnpm exec tsx scripts/spike-market.ts [prod|uat]
import { TM_BASE_URLS } from "@glade/shared";
import { createTmClient } from "@glade/tm-client";

const env = (process.argv[2] ?? "prod") as "prod" | "uat";
const tm = createTmClient({ restBase: TM_BASE_URLS[env].rest });

async function probe(label: string, fn: () => Promise<unknown>) {
  const t0 = Date.now();
  try {
    const r = await fn();
    console.log(`ok   ${label} (${Date.now() - t0} ms) ${summarize(r)}`);
  } catch (e) {
    console.log(`FAIL ${label}: ${String(e).slice(0, 200)}`);
  }
}

function summarize(r: unknown): string {
  const o = r as { points?: { t: string; price?: string; funding_rate?: string | null }[]; candles?: unknown[] } & Record<string, unknown>;
  if (Array.isArray(r)) return `items=${r.length}`;
  if (o.points) {
    const p = o.points;
    return `points=${p.length} first=${p[0]?.t} last=${p.at(-1)?.t} lastVal=${p.at(-1)?.price ?? p.at(-1)?.funding_rate}`;
  }
  if (o.candles) return `candles=${JSON.stringify(o.candles).slice(0, 160)}`;
  return JSON.stringify(r).slice(0, 160);
}

await probe("NVDA spot price", () => tm.prices("NVDA"));
await probe("NVDA perp price", () => tm.prices("NVDA", "perp"));
await probe("SP500 perp price", () => tm.prices("SP500", "perp"));
await probe("NVDA spot 90d/1d", () => tm.priceHistory({ symbol: "NVDA", window: "3M", resolution: "1d" }));
await probe("SP500 perp 90d/1d", () => tm.priceHistory({ symbol: "SP500", window: "3M", resolution: "1d", assetClass: "perp" }));
await probe("NVDA perp 7d/1h", () => tm.priceHistory({ symbol: "NVDA", window: "7d", resolution: "1h", assetClass: "perp" }));
await probe("NVDA spot 7d/1h", () => tm.priceHistory({ symbol: "NVDA", window: "7d", resolution: "1h" }));
await probe("SP500 funding 7d/1h", () => tm.perpHistory({ symbol: "SP500", window: "7d", resolution: "1h" }));
await probe("perp catalog", async () => {
  const a = await tm.listAssets({ product_type: "perp" });
  return a.filter((x) => ["NVDA", "TSLA", "AAPL", "SP500", "XYZ100", "SPCX"].includes(x.symbol ?? "")).map((x) => `${x.symbol}:L${x.perp?.max_leverage}:f${x.perp?.funding_rate}`);
});
await probe("stock catalog", async () => (await tm.listAssets({ asset_class: "stock" })).length);
